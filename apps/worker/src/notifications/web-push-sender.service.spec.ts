import { UnrecoverableError } from 'bullmq'
import type { PinoLogger } from 'nestjs-pino'
import { WebPushError } from 'web-push'

import type { PrismaService } from '@platform/core/database'
import { MembershipStatus } from '@platform/core/domain'
import { NotificationTypes, notificationMessageKey } from '@platform/core/notifications'

import { WebPushSender } from './web-push-sender.service'
import type { WebPushGateway } from './web-push.gateway'

const USER = '11111111-1111-4111-8111-111111111111'
const NOTIFICATION = '22222222-2222-4222-8222-222222222222'
const STORE = '33333333-3333-4333-8333-333333333333'

const notificationRow = (overrides: Record<string, unknown> = {}) => ({
  id: NOTIFICATION,
  storeId: STORE,
  type: NotificationTypes.CONVERSATION_ASSIGNED,
  severity: 'info',
  messageKey: notificationMessageKey(NotificationTypes.CONVERSATION_ASSIGNED),
  params: {},
  resourceId: 'c1',
  actionPath: '/s/s1/inbox/c1',
  readAt: null,
  user: { locale: 'en' },
  ...overrides
})
const subscription = (id: string) => ({
  id,
  endpoint: `https://fcm.googleapis.com/fcm/send/${id}`,
  p256dh: 'p',
  auth: 'a'
})
const pushError = (status: number): WebPushError =>
  new WebPushError('refused', status, {}, '', 'https://fcm.googleapis.com/x')

describe('WebPushSender', () => {
  const findNotification = jest.fn<Promise<unknown>, [unknown]>()
  const findSubscriptions = jest.fn<Promise<unknown>, [unknown]>()
  const countMembers = jest.fn<Promise<number>, [unknown]>()
  const updateSubscription = jest.fn()
  const deleteSubscriptions = jest.fn()
  const send = jest.fn<Promise<void>, [{ endpoint: string }, string, boolean]>()
  let enabled = true

  const sender = (): WebPushSender => {
    const prisma = {
      client: {
        notification: { findFirst: findNotification },
        membership: { count: countMembers },
        pushSubscription: {
          findMany: findSubscriptions,
          updateMany: updateSubscription,
          deleteMany: deleteSubscriptions
        }
      }
    }
    const gateway = {
      get enabled() {
        return enabled
      },
      send
    }
    const logger = { setContext: jest.fn(), warn: jest.fn(), error: jest.fn() }
    return new WebPushSender(
      prisma as unknown as PrismaService,
      gateway as unknown as WebPushGateway,
      logger as unknown as PinoLogger
    )
  }

  beforeEach(() => {
    jest.resetAllMocks()
    enabled = true
    findNotification.mockResolvedValue(notificationRow())
    findSubscriptions.mockResolvedValue([subscription('s1')])
    countMembers.mockResolvedValue(1)
    send.mockResolvedValue(undefined)
    updateSubscription.mockResolvedValue({ count: 1 })
  })

  it('sends the text, in the language of the person, to each browser of the person', async () => {
    findSubscriptions.mockResolvedValue([subscription('s1'), subscription('s2')])
    await sender().send(USER, NOTIFICATION)

    expect(send).toHaveBeenCalledTimes(2)
    const [target, body] = send.mock.calls[0] ?? []
    expect(target?.endpoint).toContain('/s1')
    expect(JSON.parse(body ?? '{}')).toMatchObject({
      notificationId: NOTIFICATION,
      title: 'Conversation assigned to you',
      tag: 'conversation.assigned:c1'
    })
    expect(send.mock.calls[0]?.[2]).toBe(false)
    expect(updateSubscription).toHaveBeenCalledTimes(2)
  })

  it('looks for the notification of this person only', async () => {
    await sender().send(USER, NOTIFICATION)
    expect(findNotification.mock.calls[0]?.[0]).toMatchObject({
      where: { id: NOTIFICATION, userId: USER }
    })
    expect(findSubscriptions.mock.calls[0]?.[0]).toEqual({ where: { userId: USER } })
  })

  it('pushes only for a store the person can still enter: a suspended or removed member gets nothing', async () => {
    countMembers.mockResolvedValue(0)
    await sender().send(USER, NOTIFICATION)

    // Asked for the store of the notification and for an active membership, nothing else
    expect(countMembers.mock.calls[0]?.[0]).toEqual({
      where: { userId: USER, storeId: STORE, status: MembershipStatus.ACTIVE, revokedAt: null }
    })
    expect(findSubscriptions).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('asks for attention on an error', async () => {
    findNotification.mockResolvedValue(notificationRow({ severity: 'error' }))
    await sender().send(USER, NOTIFICATION)
    expect(send.mock.calls[0]?.[2]).toBe(true)
  })

  it('sends nothing without keys, for a notification that is gone or already read, or no browser', async () => {
    enabled = false
    await sender().send(USER, NOTIFICATION)
    enabled = true
    findNotification.mockResolvedValueOnce(null)
    await sender().send(USER, NOTIFICATION)
    findNotification.mockResolvedValueOnce(notificationRow({ readAt: new Date() }))
    await sender().send(USER, NOTIFICATION)
    findSubscriptions.mockResolvedValueOnce([])
    await sender().send(USER, NOTIFICATION)

    expect(send).not.toHaveBeenCalled()
  })

  it.each([404, 410])('drops a subscription the push service answers %i for', async status => {
    send.mockRejectedValue(pushError(status))
    await expect(sender().send(USER, NOTIFICATION)).resolves.toBeUndefined()
    expect(deleteSubscriptions).toHaveBeenCalledWith({ where: { id: 's1', userId: USER } })
  })

  it.each([429, 500, 503])('retries the job when the push service answers %i', async status => {
    send.mockRejectedValue(pushError(status))
    await expect(sender().send(USER, NOTIFICATION)).rejects.toThrow('could not be reached')
    expect(deleteSubscriptions).not.toHaveBeenCalled()
  })

  it('retries the job when the network fails', async () => {
    send.mockRejectedValue(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))
    await expect(sender().send(USER, NOTIFICATION)).rejects.toThrow('could not be reached')
  })

  it('retries a request that timed out', async () => {
    send.mockRejectedValue(new Error('Socket timeout'))
    await expect(sender().send(USER, NOTIFICATION)).rejects.toThrow('could not be reached')
  })

  it('does not retry a url or a certificate that will not change', async () => {
    send.mockRejectedValue(Object.assign(new Error('bad url'), { code: 'ERR_INVALID_URL' }))
    await expect(sender().send(USER, NOTIFICATION)).resolves.toBeUndefined()
  })

  it('does not retry keys the library refuses to use', async () => {
    send.mockRejectedValue(new Error('The subscription p256dh is not a valid key'))
    await expect(sender().send(USER, NOTIFICATION)).resolves.toBeUndefined()
  })

  it.each([400, 401, 403, 413])('does not retry what the push service answers %i', async status => {
    send.mockRejectedValue(pushError(status))
    await expect(sender().send(USER, NOTIFICATION)).resolves.toBeUndefined()
    expect(deleteSubscriptions).not.toHaveBeenCalled()
  })

  it('still reaches the other browsers when one fails', async () => {
    findSubscriptions.mockResolvedValue([subscription('s1'), subscription('s2')])
    send.mockRejectedValueOnce(pushError(410)).mockResolvedValueOnce(undefined)
    await sender().send(USER, NOTIFICATION)
    expect(send).toHaveBeenCalledTimes(2)
    expect(updateSubscription).toHaveBeenCalledTimes(1)
  })

  it('does not retry a delivered push because its date could not be saved', async () => {
    updateSubscription.mockRejectedValue(new Error('db down'))
    await expect(sender().send(USER, NOTIFICATION)).resolves.toBeUndefined()
  })

  it('refuses for good a notification whose text is missing', async () => {
    findNotification.mockResolvedValue(notificationRow({ messageKey: 'notifications.nope' }))
    await expect(sender().send(USER, NOTIFICATION)).rejects.toBeInstanceOf(UnrecoverableError)
  })

  it('refuses for good a notification that does not fit a push', async () => {
    findNotification.mockResolvedValue(notificationRow({ type: 'not.a.type' }))
    await expect(sender().send(USER, NOTIFICATION)).rejects.toBeInstanceOf(UnrecoverableError)
  })
})
