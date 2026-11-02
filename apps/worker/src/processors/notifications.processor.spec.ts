import { type Job, UnrecoverableError } from 'bullmq'

import { JobNames, type SendWebPushJob } from '@platform/core/queues'

import type { WebPushSender } from '../notifications/web-push-sender.service'

import { NotificationsProcessor } from './notifications.processor'
import type { ProcessorSupport } from './processor-support'

const USER = '11111111-1111-4111-8111-111111111111'
const NOTIFICATION = '22222222-2222-4222-8222-222222222222'

describe('NotificationsProcessor', () => {
  const send = jest.fn<Promise<void>, [string, string]>()
  // The inherited support (logs, metrics, dead letter) is not what is under test: it runs the job
  const support = {
    run: (_queue: string, job: Job, run: (job: Job) => Promise<void>) => run(job)
  }
  const processor = new NotificationsProcessor(
    support as unknown as ProcessorSupport,
    { send } as unknown as WebPushSender
  )
  const job = (name: string, data: unknown): Job<SendWebPushJob> =>
    ({ name, data }) as unknown as Job<SendWebPushJob>

  beforeEach(() => {
    send.mockReset().mockResolvedValue(undefined)
  })

  it('sends the push of the notification it names', async () => {
    await processor.process(
      job(JobNames.SEND_WEB_PUSH, { userId: USER, notificationId: NOTIFICATION })
    )
    expect(send).toHaveBeenCalledWith(USER, NOTIFICATION)
  })

  it('refuses for good a job it does not know and a payload that does not fit', async () => {
    await expect(
      processor.process(job(JobNames.SEND_EMAIL_DIGEST, { userId: USER }))
    ).rejects.toBeInstanceOf(UnrecoverableError)
    await expect(
      processor.process(job(JobNames.SEND_WEB_PUSH, { userId: 'x', notificationId: NOTIFICATION }))
    ).rejects.toBeInstanceOf(UnrecoverableError)
    expect(send).not.toHaveBeenCalled()
  })

  it('lets a failure of the send reach the queue, which retries it', async () => {
    send.mockRejectedValue(new Error('a push service could not be reached'))
    await expect(
      processor.process(job(JobNames.SEND_WEB_PUSH, { userId: USER, notificationId: NOTIFICATION }))
    ).rejects.toThrow('could not be reached')
  })
})
