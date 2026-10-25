import { randomUUID } from 'node:crypto'

import { JobNames, QueueNames } from '@platform/core/queues'

import { deleteMessagesTo, messagesTo, waitForMessages } from './testing/mailpit'
import { magicLinkJob, startWorkerTestApp, type WorkerTestApp } from './testing/worker-test-app'

const recipient = (): string => `it-${randomUUID().slice(0, 8)}@example.com`
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await sleep(50)
  }
}

describe('SEND_EMAIL', () => {
  let test: WorkerTestApp
  let to: string

  beforeEach(async () => {
    test = await startWorkerTestApp()
    to = recipient()
  })

  afterEach(async () => {
    await test.app.close().catch(() => undefined) // A test may have closed it already
    await test.cleanUp()
    await deleteMessagesTo(to)
    jest.restoreAllMocks()
  })

  it('delivers a job enqueued from outside the worker to Mailpit', async () => {
    await test.queue(QueueNames.EMAIL).add(JobNames.SEND_EMAIL, magicLinkJob(to))

    const [message] = await waitForMessages(to)

    expect(message?.Subject).toBe('Your sign-in link')
    expect(message?.From.Address).toBe('noreply@platform.local')
    expect(message?.HTML).toContain('https://app.example.com/auth/magic?token=abc123')
    expect(message?.Text).toContain('https://app.example.com/auth/magic?token=abc123')
  })

  it('renders in the locale of the job', async () => {
    await test.queue(QueueNames.EMAIL).add(JobNames.SEND_EMAIL, magicLinkJob(to, { locale: 'es' }))
    const [message] = await waitForMessages(to)
    expect(message?.Subject).toBe('Tu enlace para iniciar sesión')
  })

  it('lets a job in flight finish when the worker is stopped (graceful shutdown)', async () => {
    const send = test.email.send.bind(test.email)
    let started = false
    jest.spyOn(test.email, 'send').mockImplementation(async job => {
      started = true
      await sleep(1500) // Still sending when the shutdown arrives
      await send(job)
    })
    const queue = test.queue(QueueNames.EMAIL)
    const job = await queue.add(JobNames.SEND_EMAIL, magicLinkJob(to))
    await waitFor(() => started)

    await test.app.close() // BullMQ's Worker.close() waits for the active job

    await expect(waitForMessages(to)).resolves.toHaveLength(1)
    expect(await job.getState()).toBe('completed')
  })

  it('retries a failed attempt and delivers exactly once', async () => {
    const send = test.email.send.bind(test.email)
    let calls = 0
    jest.spyOn(test.email, 'send').mockImplementation(async job => {
      calls += 1
      if (calls === 1) throw new Error('provider down')
      await send(job)
    })

    await test.queue(QueueNames.EMAIL).add(JobNames.SEND_EMAIL, magicLinkJob(to))

    await waitForMessages(to, 1, 20_000) // The retry waits 2 s (exponential backoff)
    await sleep(500)
    expect(calls).toBe(2)
    expect(await waitForMessages(to)).toHaveLength(1)
  }, 30_000)

  it('moves a job that spent its attempts to the dead-letter queue, keeping the failed job', async () => {
    jest.spyOn(test.email, 'send').mockRejectedValue(new Error('provider down'))
    const queue = test.queue(QueueNames.EMAIL)
    const job = await queue.add(JobNames.SEND_EMAIL, magicLinkJob(to))
    const deadLetter = test.queue(QueueNames.DEAD_LETTER)

    const deadline = Date.now() + 25_000
    while ((await deadLetter.getJobCounts('waiting')).waiting === 0) {
      if (Date.now() > deadline) throw new Error('the job never reached the dead-letter queue')
      await sleep(250)
    }

    const [exhausted] = await deadLetter.getJobs(['waiting'])
    expect(exhausted?.name).toBe(JobNames.EXHAUSTED)
    expect(exhausted?.data).toMatchObject({
      originalQueue: QueueNames.EMAIL,
      originalJobName: JobNames.SEND_EMAIL,
      originalJobId: job.id,
      error: 'provider down'
    })
    const failed = await queue.getJob(job.id ?? '') // Stays here: Bull Board retries it in place
    expect(await failed?.getState()).toBe('failed')
    expect(failed?.attemptsMade).toBe(3)
  }, 40_000)

  it('does not retry a payload the template rejects, and sends it to the dead letter at once', async () => {
    const queue = test.queue(QueueNames.EMAIL)
    const job = await queue.add(
      JobNames.SEND_EMAIL,
      magicLinkJob(to, { data: { url: 'javascript:alert(1)', expiresInMinutes: 15 } })
    )
    const deadLetter = test.queue(QueueNames.DEAD_LETTER)

    const deadline = Date.now() + 10_000
    while ((await deadLetter.getJobCounts('waiting')).waiting === 0) {
      if (Date.now() > deadline) throw new Error('the job never reached the dead-letter queue')
      await sleep(100)
    }

    expect(await job.getState()).toBe('failed')
    expect((await queue.getJob(job.id ?? ''))?.attemptsMade).toBe(1)
    expect(await messagesTo(to)).toEqual([]) // Nothing went out with the rejected payload
  })
})
