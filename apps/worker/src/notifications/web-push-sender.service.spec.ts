import { UnrecoverableError } from 'bullmq'
import type { PinoLogger } from 'nestjs-pino'
import { WebPushError } from 'web-push'

import { JobContextGoneError, type JobContext, type PrismaService } from '@platform/core/database'
import { MembershipStatus } from '@platform/core/domain'
import { NotificationTypes, notificationMessageKey, PushLimits } from '@platform/core/notifications'

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
  const forUser = jest.fn((_userId: string, work: () => Promise<unknown>) => work())
  const logger = { setContext: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
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
    return new WebPushSender(
      prisma as unknown as PrismaService,
      { forUser } as unknown as JobContext,
      gateway as unknown as WebPushGateway,
      logger as unknown as PinoLogger
    )
  }

  beforeEach(() => {
    jest.resetAllMocks()
    forUser.mockImplementation((_userId, work) => work())
    enabled = true
    findNotification.mockResolvedValue(notificationRow())
    findSubscriptions.mockResolvedValue([subscription('s1')])
    countMembers.mockResolvedValue(1)
    send.mockResolvedValue(undefined)
    updateSubscription.mockResolvedValue({ count: 1 })
    deleteSubscriptions.mockResolvedValue({ count: 0 })
  })

  describe('says why nothing was pushed', () => {
    const reasonsLogged = (): unknown[] =>
      logger.info.mock.calls.map((call: unknown[]) => (call[0] as { reason: string }).reason)

    it('names the missing keys', async () => {
      enabled = false
      await sender().send(USER, NOTIFICATION)
      expect(reasonsLogged()).toEqual(['no_vapid_keys'])
    })

    it('names a notification that is gone, one already read and a person out of the store', async () => {
      findNotification.mockResolvedValueOnce(null)
      await sender().send(USER, NOTIFICATION)
      findNotification.mockResolvedValueOnce(notificationRow({ readAt: new Date() }))
      await sender().send(USER, NOTIFICATION)
      countMembers.mockResolvedValueOnce(0)
      await sender().send(USER, NOTIFICATION)
      expect(reasonsLogged()).toEqual(['notification_gone', 'already_read', 'not_a_member'])
    })

    it('reads in the context of the person and names a person who was deleted', async () => {
      await sender().send(USER, NOTIFICATION)
      expect(forUser).toHaveBeenCalledWith(USER, expect.any(Function))
      forUser.mockRejectedValueOnce(new JobContextGoneError('the user of the job does not exist'))
      await sender().send(USER, NOTIFICATION)
      expect(reasonsLogged()).toEqual(['user_gone'])
    })

    it('names a person with no browser registered', async () => {
      findSubscriptions.mockResolvedValue([])
      await sender().send(USER, NOTIFICATION)
      expect(reasonsLogged()).toEqual(['no_subscription'])
    })

    it('names a browser the push service forgot, which is dropped', async () => {
      send.mockRejectedValue(pushError(410))
      await sender().send(USER, NOTIFICATION)
      expect(reasonsLogged()).toEqual(['subscription_gone'])
    })

    it('never writes the endpoint, the text or the keys of a browser', async () => {
      send.mockRejectedValue(pushError(410))
      await sender().send(USER, NOTIFICATION)
      expect(JSON.stringify(logger.info.mock.calls)).not.toMatch(/fcm\.googleapis|"p"|"a"/)
    })
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
  })

  it('counts a 400, which names the subscription itself, and drops it only at the limit', async () => {
    send.mockRejectedValue(pushError(400))
    await sender().send(USER, NOTIFICATION)
    expect(updateSubscription).toHaveBeenCalledWith({
      where: {
        id: 's1',
        userId: USER,
        OR: [{ refusedNotificationId: null }, { refusedNotificationId: { not: NOTIFICATION } }]
      },
      data: { refusedCount: { increment: 1 }, refusedNotificationId: NOTIFICATION }
    })
    expect(deleteSubscriptions).toHaveBeenCalledWith({
      where: { id: 's1', userId: USER, refusedCount: { gte: PushLimits.MAX_REFUSALS } }
    })
    expect(logger.warn).not.toHaveBeenCalled()
  })

  // A rotated or wrong VAPID key, a payload that is too big, a library or certificate error: the fault is the server's, and counting it
  // would empty every list of browsers after five pushes
  it.each([401, 403, 413])('does not count a %i against the browser', async status => {
    send.mockRejectedValue(pushError(status))
    await sender().send(USER, NOTIFICATION)
    expect(updateSubscription).not.toHaveBeenCalled()
    expect(deleteSubscriptions).not.toHaveBeenCalled()
  })

  it('does not count an error of the library against the browser', async () => {
    send.mockRejectedValue(new Error('The subscription p256dh is not a valid key'))
    await sender().send(USER, NOTIFICATION)
    expect(updateSubscription).not.toHaveBeenCalled()
  })

  it('counts a notification once for a browser even when the job is retried for another one', async () => {
    findSubscriptions.mockResolvedValue([subscription('s1'), subscription('s2')])
    send.mockImplementation(({ endpoint }) =>
      Promise.reject(endpoint.endsWith('/s1') ? pushError(400) : pushError(503))
    )
    await expect(sender().send(USER, NOTIFICATION)).rejects.toThrow('could not be reached')
    const counting = updateSubscription.mock.calls as [
      { where: { id: string; OR: unknown[] }; data: { refusedNotificationId: string } }
    ][]
    // The filter is what makes the second attempt a no-op: it only matches a row that this notification has not counted yet
    expect(counting).toHaveLength(1)
    expect(counting[0]?.[0].where.id).toBe('s1')
    expect(counting[0]?.[0].where.OR).toEqual([
      { refusedNotificationId: null },
      { refusedNotificationId: { not: NOTIFICATION } }
    ])
    expect(counting[0]?.[0].data.refusedNotificationId).toBe(NOTIFICATION)
  })

  it('says why a browser was dropped when its refusals reach the limit', async () => {
    send.mockRejectedValue(pushError(400))
    deleteSubscriptions.mockResolvedValue({ count: 1 })
    await sender().send(USER, NOTIFICATION)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'refused_too_often', subscriptionId: 's1' }),
      expect.any(String)
    )
  })

  it('does not retry the job when a refusal could not be counted', async () => {
    send.mockRejectedValue(pushError(400))
    updateSubscription.mockRejectedValue(new Error('db down'))
    await expect(sender().send(USER, NOTIFICATION)).resolves.toBeUndefined()
    expect(deleteSubscriptions).not.toHaveBeenCalled()
  })

  it('does not count a browser that is gone (it is dropped at once) or a network failure (it is retried)', async () => {
    send.mockRejectedValueOnce(pushError(410))
    await sender().send(USER, NOTIFICATION)
    send.mockRejectedValueOnce(pushError(503))
    await expect(sender().send(USER, NOTIFICATION)).rejects.toThrow('could not be reached')
    expect(updateSubscription).not.toHaveBeenCalled()
  })

  it('starts the count again when a push is delivered', async () => {
    await sender().send(USER, NOTIFICATION)
    const call = updateSubscription.mock.calls[0] as [
      {
        where: unknown
        data: { lastUsed: unknown; refusedCount: number; refusedNotificationId: null }
      }
    ]
    expect(call[0].where).toEqual({ id: 's1', userId: USER })
    expect(call[0].data.lastUsed).toBeInstanceOf(Date)
    expect(call[0].data.refusedCount).toBe(0)
    expect(call[0].data.refusedNotificationId).toBeNull()
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
