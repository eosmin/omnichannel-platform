import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { Queue } from 'bullmq'
import type { Redis } from 'ioredis'
import pg from 'pg'

import { MAGIC_LINK_EMAIL_THROTTLER } from '@platform/core/auth'
import { AccessTokenModule, type AuthSettings } from '@platform/core/auth-module'
import { CacheKeys } from '@platform/core/cache'
import { DatabaseModule, PrismaService } from '@platform/core/database'
import { connectionUrls } from '@platform/core/database-testing'
import {
  BullBoardModule,
  configureHttpApp,
  HttpErrorsModule,
  ThrottlerPlatformModule
} from '@platform/core/http'
import { LoggerModule } from '@platform/core/logger'
import { MetricsModule } from '@platform/core/metrics-module'
import { QueueNames, type SendEmailJob } from '@platform/core/queues'
import { QueueJobOptions, QueuesModule } from '@platform/core/queues-module'
import { REDIS_CLIENT, RedisModule } from '@platform/core/redis'

import { AccountService } from '../modules/auth/account.service'
import { AuthController } from '../modules/auth/auth.controller'
import { emailLimitKey, MagicLinkService } from '../modules/auth/magic-link.service'
import { SessionService } from '../modules/auth/session.service'

import { REDIS_URL } from './test-env'

export const FRONTEND_URL = 'https://app.example.com'
export const settings: AuthSettings = {
  jwtSecret: 'a-secret-of-at-least-thirty-two-characters!',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 604_800,
  sessionMaxAgeSeconds: 2_592_000, // 30 days
  frontendUrl: FRONTEND_URL
}

export interface AuthTestApp {
  app: INestApplication
  url: string // Where the app listens: the routes under /api/v1
  prisma: PrismaService
  sessions: SessionService
  magicLinks: MagicLinkService
  runId: string
  // A user of this run, created as the owner (the api cannot create users yet)
  createUser(overrides?: {
    email?: string
    emailValid?: boolean
    locale?: string
  }): Promise<{ id: string; email: string }>
  // Runs a statement as the database owner, for what the api role cannot or should not do
  asOwner<T>(work: (client: pg.Client) => Promise<T>): Promise<T>
  emailJobs(): Promise<SendEmailJob[]>
  // The queue the services write to, to look at the jobs themselves
  emailQueue: Queue
  // The per-address limit of the magic link lives in a Redis that every run shares: a test that
  // asks for one fixed address starts from a clean count
  forgetEmailLimit(email: string): Promise<void>
  cleanUp(): Promise<void>
}

// The login path of the api with the real Postgres and Redis, and nothing else of the app
export async function startAuthTestApp(
  options: { bullBoardAdmins?: readonly string[]; runId?: string } = {}
): Promise<AuthTestApp> {
  const runId = options.runId ?? randomUUID().slice(0, 8)
  const urls = connectionUrls()
  const prefix = `it-${runId}`
  const queuesModule = QueuesModule.forRoot({ redisUrl: REDIS_URL, prefix })
  const moduleRef = await Test.createTestingModule({
    imports: [
      LoggerModule.forRoot({ level: 'fatal', pretty: false }),
      MetricsModule,
      DatabaseModule.forRoot({ databaseUrl: urls.app, poolSize: 6 }),
      RedisModule.forRoot({ url: REDIS_URL }),
      queuesModule,
      HttpErrorsModule,
      // Before the auth module, as in HttpPlatformModule: the guards run in the order registered
      ThrottlerPlatformModule,
      AccessTokenModule.forRoot(settings),
      // Mounted like the app does when BULL_BOARD_ENABLED is on; absent otherwise
      ...(options.bullBoardAdmins === undefined
        ? []
        : [
            BullBoardModule.forRoot({
              adminEmails: options.bullBoardAdmins,
              imports: [queuesModule]
            })
          ])
    ],
    controllers: [AuthController],
    providers: [SessionService, MagicLinkService, AccountService]
  }).compile()
  const app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true })
  // One proxy hop, so that a test picks its own client address with X-Forwarded-For: the limits
  // are counted in a Redis that every run shares, and 127.0.0.1 would be spent by the run before
  app.set('trust proxy', 1)
  await configureHttpApp(app)
  await app.listen(0)

  const asOwner = async <T>(work: (client: pg.Client) => Promise<T>): Promise<T> => {
    const client = new pg.Client({ connectionString: urls.owner })
    await client.connect()
    try {
      return await work(client)
    } finally {
      await client.end()
    }
  }

  let counter = 0
  const queueHandle = new Queue(QueueNames.EMAIL, {
    connection: { url: REDIS_URL },
    prefix,
    defaultJobOptions: QueueJobOptions[QueueNames.EMAIL]
  })

  return {
    app,
    url: await app.getUrl(),
    prisma: app.get(PrismaService),
    sessions: app.get(SessionService),
    magicLinks: app.get(MagicLinkService),
    runId,
    asOwner,
    emailQueue: queueHandle,
    forgetEmailLimit: async email => {
      const key = CacheKeys.rateLimit(MAGIC_LINK_EMAIL_THROTTLER, emailLimitKey(email))
      await app.get<Redis>(REDIS_CLIENT).del(key, `${key}:block`)
    },
    createUser: async (overrides = {}) => {
      counter += 1
      const email = overrides.email ?? `it-${runId}-${counter}@example.com`
      const id = randomUUID()
      await asOwner(client =>
        client.query(
          `INSERT INTO users (id, email, name, email_valid, locale, updated_at)
           VALUES ($1, $2, 'Test User', $3, $4, now())`,
          [id, email, overrides.emailValid ?? true, overrides.locale ?? 'es']
        )
      )
      return { id, email }
    },
    emailJobs: async () => {
      const jobs = await queueHandle.getJobs(['waiting', 'delayed', 'active'])
      // Oldest first: BullMQ lists the waiting jobs newest first, and ids grow with each job
      jobs.sort((a, b) => Number(a.id) - Number(b.id))
      return jobs.map(job => job.data as SendEmailJob) // The queue was written by the code under test
    },
    cleanUp: async () => {
      await asOwner(client =>
        client.query('DELETE FROM users WHERE email LIKE $1', [`it-${runId}-%`])
      )
      await queueHandle.obliterate({ force: true })
      await queueHandle.close()
      await app.close()
    }
  }
}
