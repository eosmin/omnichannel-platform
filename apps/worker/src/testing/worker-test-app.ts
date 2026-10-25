import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { Queue } from 'bullmq'

import { EmailModule, EmailService } from '@platform/core/email'
import { Locales } from '@platform/core/i18n'
import { LoggerModule } from '@platform/core/logger'
import { MetricsModule } from '@platform/core/metrics-module'
import { EmailTemplates, type QueueName, type SendEmailJob } from '@platform/core/queues'
import { QueueJobOptions, QueuesModule } from '@platform/core/queues-module'
import { RedisModule } from '@platform/core/redis'

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
      MetricsModule,
      RedisModule.forRoot({ url: REDIS_URL }),
      QueuesModule.forRoot({ redisUrl: REDIS_URL, prefix }),
      EmailModule.forRoot({ from: 'Platform <noreply@platform.local>', smtpUrl: SMTP_URL })
    ],
    providers: [ProcessorSupport, EmailProcessor]
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
