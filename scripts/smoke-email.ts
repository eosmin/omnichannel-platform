// Sends an email through the built worker and waits for it in Mailpit. The unit and integration
// suites run the templates under ts-jest; only the bundle the image runs can show that they still
// render there (a JSX runtime or a bundling mistake fails with "React is not defined").
// Needs a running worker, Redis on localhost:6379 and Mailpit on localhost:8025.
// The worker reads the queues under a prefix (QUEUE_PREFIX, or derived from the name of DATABASE_URL): run this
// with the same QUEUE_PREFIX the worker has, or with the same database name in DATABASE_URL.
// Usage: tsx scripts/smoke-email.ts
import { randomUUID } from 'node:crypto'
import { exit } from 'node:process'

import { Queue } from 'bullmq'
import { z } from 'zod'

import { Locales } from '@platform/core/i18n'
import { EmailTemplates, JobNames, QueueNames } from '@platform/core/queues'
import { QueueJobOptions, queuePrefixFor } from '@platform/core/queues-module'

import { loadQueueEnv } from './queue-env'

const REDIS_URL = 'redis://localhost:6379'
const MAILPIT = 'http://localhost:8025/api/v1'
const TIMEOUT_MS = 20_000
const POLL_MS = 250
const TOKEN = randomUUID()

const searchSchema = z.object({ messages: z.array(z.object({ ID: z.string() })) })
const messageSchema = z.object({ Subject: z.string(), Text: z.string(), HTML: z.string() })

const recipient = `smoke-${TOKEN.slice(0, 8)}@example.com`
const search = `${MAILPIT}/search?query=${encodeURIComponent(`to:${recipient}`)}`

const queueEnv = loadQueueEnv()
if (queueEnv.QUEUE_PREFIX === undefined && queueEnv.DATABASE_URL === undefined) {
  console.error('smoke-email: set QUEUE_PREFIX or DATABASE_URL, as the worker has them')
  exit(1)
}
const queue = new Queue(QueueNames.EMAIL, {
  connection: { url: REDIS_URL },
  prefix: queuePrefixFor(queueEnv.DATABASE_URL ?? '', queueEnv.QUEUE_PREFIX),
  defaultJobOptions: QueueJobOptions[QueueNames.EMAIL]
})
try {
  await queue.add(JobNames.SEND_EMAIL, {
    template: EmailTemplates.MAGIC_LINK,
    to: recipient,
    locale: Locales.ES,
    data: { url: `https://app.example.com/auth/magic?token=${TOKEN}`, expiresInMinutes: 15 },
    tags: { template: EmailTemplates.MAGIC_LINK }
  })
} finally {
  await queue.close()
}

const deadline = Date.now() + TIMEOUT_MS
for (;;) {
  const found = searchSchema.parse(await (await fetch(search)).json())
  const first = found.messages[0]
  if (first !== undefined) {
    const message = messageSchema.parse(
      await (await fetch(`${MAILPIT}/message/${first.ID}`)).json()
    )
    await fetch(search, { method: 'DELETE' })
    const problems = [
      !message.Text.includes(TOKEN) && 'the text version lacks the link',
      !message.HTML.includes(`token=${TOKEN}`) && 'the html lacks the link',
      message.Subject === '' && 'no subject'
    ].filter((problem): problem is string => problem !== false)
    if (problems.length > 0) {
      console.error(`the email arrived but is wrong: ${problems.join(', ')}`)
      exit(1)
    }
    console.log(`email rendered by the worker and delivered: "${message.Subject}"`)
    exit(0)
  }
  if (Date.now() > deadline) {
    console.error(`no email for ${recipient} in Mailpit after ${TIMEOUT_MS / 1000} seconds`)
    exit(1)
  }
  await new Promise(resolve => setTimeout(resolve, POLL_MS))
}
