import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { Queue } from 'bullmq'
import type { Redis } from 'ioredis'
import pg from 'pg'

import { AuditModule } from '@platform/core/audit-module'
import { MAGIC_LINK_EMAIL_THROTTLER, MagicLinkThrottle } from '@platform/core/auth'
import { AccessTokenModule, type AuthSettings } from '@platform/core/auth-module'
import { CacheKeys } from '@platform/core/cache'
import { DatabaseModule, PrismaService } from '@platform/core/database'
import { connectionUrls } from '@platform/core/database-testing'
import {
  BullBoardModule,
  configureHttpApp,
  HttpErrorsModule,
  MAGIC_LINK_EMAIL_LIMIT,
  StoragePlatformModule,
  ThrottlerPlatformModule
} from '@platform/core/http'
import { LoggerModule } from '@platform/core/logger'
import { MagicLinkIssuer } from '@platform/core/magic-link-issuer'
import { MetricsModule } from '@platform/core/metrics-module'
import { DIGEST_LINKS } from '@platform/core/notifications'
import {
  JobNames,
  QueueNames,
  type RequestMagicLinkJob,
  type SendEmailJob
} from '@platform/core/queues'
import { QueueJobOptions, QueuesModule } from '@platform/core/queues-module'
import { REDIS_CLIENT, RedisModule } from '@platform/core/redis'

import { AccountSettingsService } from '../modules/auth/account-settings.service'
import { AccountController } from '../modules/auth/account.controller'
import { AccountService } from '../modules/auth/account.service'
import { AuthController } from '../modules/auth/auth.controller'
import { emailLimitKey, MagicLinkService } from '../modules/auth/magic-link.service'
import { SessionService } from '../modules/auth/session.service'
import { TenancyModule } from '../modules/tenancy'

import { type TenantFixtures, tenantFixtures } from './tenant-fixtures'
import { TenantProbeController } from './tenant-probe.controller'
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
  // The emails queued, oldest first. Asking for a link only queues a request (the worker looks the
  // address up), so this first does what the worker would: it works the pending requests.
  emailJobs(): Promise<SendEmailJob[]>
  // The requests for a link that nobody has worked yet, as the api queued them
  requestJobs(): Promise<{ data: RequestMagicLinkJob; removeOnComplete: unknown }[]>
  // The queue the services write to, to look at the jobs themselves
  emailQueue: Queue
  // Stores, roles and memberships for the tenancy suites
  tenants: TenantFixtures
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
      // The picture of an account is a file in the bucket
      StoragePlatformModule,
      queuesModule,
      HttpErrorsModule,
      // Before the auth module, as in HttpPlatformModule: the guards run in the order registered
      ThrottlerPlatformModule,
      AccessTokenModule.forRoot(settings),
      // After the token check, as in the app: who is the store, then what may the user do there
      AuditModule,
      TenancyModule,
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
    controllers: [AuthController, AccountController, TenantProbeController],
    providers: [
      SessionService,
      MagicLinkService,
      // The real limit: these suites check the sixth link of a minute is refused
      { provide: MAGIC_LINK_EMAIL_LIMIT, useValue: MagicLinkThrottle.limit },
      AccountService,
      AccountSettingsService,
      // What the worker runs when it takes a request for a link (see emailJobs)
      MagicLinkIssuer,
      { provide: DIGEST_LINKS, useValue: { frontendUrl: FRONTEND_URL } }
    ]
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

  const tenants = tenantFixtures(asOwner, runId)
  let counter = 0
  const queueHandle = new Queue(QueueNames.EMAIL, {
    connection: { url: REDIS_URL },
    prefix,
    defaultJobOptions: QueueJobOptions[QueueNames.EMAIL]
  })

  // Oldest first: BullMQ lists the waiting jobs newest first, and ids grow with each job
  const pending = async (name: string) => {
    const jobs = (await queueHandle.getJobs(['waiting', 'delayed', 'active'])).filter(
      job => job.name === name
    )
    return jobs.sort((a, b) => Number(a.id) - Number(b.id))
  }

  return {
    app,
    url: await app.getUrl(),
    prisma: app.get(PrismaService),
    sessions: app.get(SessionService),
    magicLinks: app.get(MagicLinkService),
    runId,
    asOwner,
    emailQueue: queueHandle,
    tenants,
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
      for (const job of await pending(JobNames.REQUEST_MAGIC_LINK)) {
        const data = job.data as RequestMagicLinkJob
        await app.get(MagicLinkIssuer).issue(data.email, data.correlationId)
        await job.remove()
      }
      // The queue was written by the code under test
      return (await pending(JobNames.SEND_EMAIL)).map(job => job.data as SendEmailJob)
    },
    requestJobs: async () =>
      (await pending(JobNames.REQUEST_MAGIC_LINK)).map(job => ({
        data: job.data as RequestMagicLinkJob,
        removeOnComplete: job.opts.removeOnComplete
      })),
    cleanUp: async () => {
      await tenants.deleteAll()
      await asOwner(async client => {
        // The audit log keeps its rows for the users; the owner may clear them, the api never can
        await client.query(
          'DELETE FROM audit_logs WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)',
          [`it-${runId}-%`]
        )
        await client.query('DELETE FROM users WHERE email LIKE $1', [`it-${runId}-%`])
      })
      await queueHandle.obliterate({ force: true })
      await queueHandle.close()
      await app.close()
    }
  }
}
