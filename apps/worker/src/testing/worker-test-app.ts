import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { Queue } from 'bullmq'

import { EmailModule, EmailService } from '@platform/core/email'
import { Locales } from '@platform/core/i18n'
import { LoggerModule } from '@platform/core/logger'
import { MagicLinkIssuer } from '@platform/core/magic-link-issuer'
import { MetricsModule, OPEN_METRICS_ACCESS } from '@platform/core/metrics-module'
import { EmailTemplates, type QueueName, type SendEmailJob } from '@platform/core/queues'
import { QueueJobOptions, QueuesModule } from '@platform/core/queues-module'
import { RedisModule } from '@platform/core/redis'

import { DsrNoticeLedger } from '../compliance/dsr-notice-ledger.service'
import { InvitationEmailDelivery } from '../invitations/invitation-email-delivery.service'
import { AuthEmailProcessor } from '../processors/auth-email.processor'
import { EmailProcessor } from '../processors/email.processor'
import { ProcessorSupport } from '../processors/processor-support'

import { REDIS_URL, SMTP_URL } from './test-env'

export interface WorkerTestApp {
  app: INestApplication
  email: EmailService
  prefix: string
  // A queue handle of the test, to look at jobs from outside the worker
  queue(name: QueueName): Queue
  cleanUp(): Promise<void>
}

// The email path of the worker with real Redis and Mailpit, under its own key prefix so that a
// worker running on the same Redis (pnpm dev) cannot take the jobs of the test.
export async function startWorkerTestApp(): Promise<WorkerTestApp> {
  const prefix = `it-${randomUUID().slice(0, 8)}`
  const moduleRef = await Test.createTestingModule({
    imports: [
      LoggerModule.forRoot({ level: 'fatal', pretty: false }),
      MetricsModule.forRoot(OPEN_METRICS_ACCESS),
      RedisModule.forRoot({ url: REDIS_URL }),
      QueuesModule.forRoot({ redisUrl: REDIS_URL, prefix }),
      EmailModule.forRoot({ from: 'Platform <noreply@platform.local>', smtpUrl: SMTP_URL })
    ],
    providers: [
      ProcessorSupport,
      EmailProcessor,
      AuthEmailProcessor,
      // Looking an address up needs the database, which this app does not have
      // A retry of a magic link mail asks how long the link has left (`AuthEmailProcessor.stillUseful`): the stand-in says a whole link is left
      {
        provide: MagicLinkIssuer,
        useValue: {
          issue: () => Promise.resolve(),
          remainingValidityMs: () => Promise.resolve(15 * 60_000)
        }
      },
      // Nor does the delivery of invitation emails, which reads the outbox of a row (its own spec covers it)
      { provide: InvitationEmailDelivery, useValue: { deliver: () => Promise.resolve('skipped') } },
      // Nor the ledger of the closing notice of a data request, which writes the request (its own specs cover it)
      {
        provide: DsrNoticeLedger,
        useValue: { sent: () => Promise.resolve(), failed: () => Promise.resolve() }
      }
    ]
  }).compile()
  const app = moduleRef.createNestApplication()
  await app.init()

  const handles: Queue[] = []
  return {
    app,
    email: app.get(EmailService),
    prefix,
    queue: name => {
      // The retry policy belongs to the queue definition, so a producer in the test gets it too
      const handle = new Queue(name, {
        connection: { url: REDIS_URL },
        prefix,
        defaultJobOptions: QueueJobOptions[name]
      })
      handles.push(handle)
      return handle
    },
    cleanUp: async () => {
      for (const handle of handles) {
        await handle.obliterate({ force: true })
        await handle.close()
      }
    }
  }
}

export function magicLinkJob(to: string, overrides: Partial<SendEmailJob> = {}): SendEmailJob {
  return {
    template: EmailTemplates.MAGIC_LINK,
    to,
    locale: Locales.EN,
    data: { url: 'https://app.example.com/auth/magic?token=abc123', expiresInMinutes: 15 },
    tags: { template: EmailTemplates.MAGIC_LINK },
    ...overrides
  }
}
