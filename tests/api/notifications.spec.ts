import { randomUUID } from 'node:crypto'

import { getQueueToken } from '@nestjs/bullmq'
import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { Permissions } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import { DigestFrequency } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import {
  NotificationLimits,
  NotificationSeverity,
  NotificationTypes,
  notificationMessageKey,
  PushLimits
} from '@platform/core/notifications'
import { JobNames, QueueNames } from '@platform/core/queues'
import { RealtimeEvents } from '@platform/core/realtime'

import { NotificationsService } from '../../apps/api/src/modules/notifications/notifications.service'
import { RealtimeService } from '../../apps/api/src/modules/realtime/realtime.service'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'
import { CapturedQueue } from '../helpers/queue'

interface ErrorBody {
  error: { code: string }
}
interface NotificationBody {
  id: string
  type: string
  readAt: string | null
}
interface PageBody {
  data: NotificationBody[]
  nextCursor: string | null
  hasMore: boolean
}
interface PreferencesBody {
  types: { type: string; inApp: boolean; push: boolean; email: boolean; sound: boolean }[]
  settings: {
    quietHoursEnabled: boolean
    quietHoursStart: number
    quietHoursEnd: number
    timezone: string
    digestFrequency: string
  }
}

const OK = 200
const BAD_REQUEST = 400
const NOT_FOUND = 404
const NO_CONTENT = 204
// base64url of 65 and 16 bytes, the sizes of the keys of a browser
const P256DH = 'B'.repeat(87)
const P256DH_NEW = 'C'.repeat(87)
const AUTH = 'a'.repeat(22)
const AUTH_NEW = 'b'.repeat(22)

// The notifications of a member in a store: the center (list, count, read) and the preferences that
// decide what else is done with one (TDD_06 §6, §9).
describe('Notifications', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let service: NotificationsService
  const pushQueue = new CapturedQueue()

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp([], builder =>
      builder.overrideProvider(getQueueToken(QueueNames.NOTIFICATIONS)).useValue(pushQueue)
    )
    ctx = await seedTestContext(owner, app, prefix)
    service = app.get(NotificationsService, { strict: false })
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })
  afterEach(async () => {
    const users = [ctx.adminA.id, ctx.agentA.id, ctx.viewerA.id]
    await owner.notification.deleteMany({ where: { userId: { in: users } } })
    await owner.notificationPreference.deleteMany({ where: { userId: { in: users } } })
    await owner.userNotificationSettings.deleteMany({ where: { userId: { in: users } } })
    await owner.pushSubscription.deleteMany({ where: { userId: { in: users } } })
    pushQueue.jobs.length = 0
    jest.restoreAllMocks()
  })

  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)

  const make = (
    userId: string,
    type: string = NotificationTypes.EXPORT_READY,
    readAt: Date | null = null
  ) =>
    owner.notification.create({
      data: {
        userId,
        storeId: ctx.storeA.id,
        type,
        severity: NotificationSeverity.INFO,
        messageKey: notificationMessageKey(NotificationTypes.EXPORT_READY),
        readAt
      },
      select: { id: true }
    })

  describe('the center', () => {
    it('lists only the own rows of the store, newest first, by pages', async () => {
      const first = await make(ctx.adminA.id)
      const second = await make(ctx.adminA.id)
      const third = await make(ctx.adminA.id)
      await make(ctx.agentA.id)

      const page = await asAdmin().get(`${ApiRoutes.notifications.list}?limit=2`)
      const body = page.body as PageBody

      expect(page.status).toBe(OK)
      expect(body.data.map(row => row.id)).toEqual([third.id, second.id])
      expect(body.hasMore).toBe(true)
      const next = await asAdmin().get(
        `${ApiRoutes.notifications.list}?limit=2&cursor=${body.nextCursor ?? ''}`
      )
      expect((next.body as PageBody).data.map(row => row.id)).toEqual([first.id])
      expect((next.body as PageBody).hasMore).toBe(false)
    })

    it('filters the unread ones and the mentions', async () => {
      const unread = await make(ctx.adminA.id)
      await make(ctx.adminA.id, NotificationTypes.EXPORT_READY, new Date())
      const mention = await make(ctx.adminA.id, NotificationTypes.CONVERSATION_MENTIONED)

      const onlyUnread = await asAdmin().get(`${ApiRoutes.notifications.list}?filter=unread`)
      const mentions = await asAdmin().get(`${ApiRoutes.notifications.list}?filter=mentions`)

      expect((onlyUnread.body as PageBody).data.map(row => row.id).sort()).toEqual(
        [unread.id, mention.id].sort()
      )
      expect((mentions.body as PageBody).data.map(row => row.id)).toEqual([mention.id])
    })

    it('refuses a filter, a limit or a field it does not know', async () => {
      for (const query of ['filter=all-of-them', 'limit=0', 'limit=101', 'storeId=x']) {
        const response = await asAdmin().get(`${ApiRoutes.notifications.list}?${query}`)
        expect(response.status).toBe(BAD_REQUEST)
        expect((response.body as ErrorBody).error.code).toBe(ErrorCodes.VALIDATION_FAILED)
      }
    })

    it('answers a member whose role holds no permission at all', async () => {
      await make(ctx.viewerA.id)

      const response = await api(app, ctx.viewerA, ctx.storeA).get(
        ApiRoutes.notifications.unreadCount
      )

      expect(response.status).toBe(OK)
      expect(response.body).toEqual({ count: 1 })
    })

    it('counts the unread rows of the user in the store of the header', async () => {
      await make(ctx.adminA.id)
      await make(ctx.adminA.id, NotificationTypes.EXPORT_READY, new Date())
      await owner.notification.create({
        data: {
          userId: ctx.adminA.id,
          storeId: ctx.storeA2.id,
          type: NotificationTypes.EXPORT_READY,
          severity: NotificationSeverity.INFO,
          messageKey: notificationMessageKey(NotificationTypes.EXPORT_READY)
        }
      })

      const response = await asAdmin().get(ApiRoutes.notifications.unreadCount)

      expect(response.body).toEqual({ count: 1 })
    })

    it('stops counting at one past the badge cap', async () => {
      await owner.notification.createMany({
        data: Array.from({ length: NotificationLimits.BADGE_CAP + 5 }, () => ({
          userId: ctx.adminA.id,
          storeId: ctx.storeA.id,
          type: NotificationTypes.EXPORT_READY,
          severity: NotificationSeverity.INFO,
          messageKey: notificationMessageKey(NotificationTypes.EXPORT_READY)
        }))
      })

      const response = await asAdmin().get(ApiRoutes.notifications.unreadCount)

      expect(response.body).toEqual({ count: NotificationLimits.BADGE_CAP + 1 })
    })

    it('marks rows read once, skips ids of others, and answers 404 when none is the own', async () => {
      const mine = await make(ctx.adminA.id)
      const alreadyRead = await make(ctx.adminA.id, NotificationTypes.EXPORT_READY, new Date(0))
      const theirs = await make(ctx.agentA.id)

      const response = await asAdmin()
        .post(ApiRoutes.notifications.markRead)
        .send({ ids: [mine.id, alreadyRead.id, theirs.id] })
      const again = await asAdmin()
        .post(ApiRoutes.notifications.markRead)
        .send({ ids: [mine.id] })
      const strangers = await asAdmin()
        .post(ApiRoutes.notifications.markRead)
        .send({ ids: [theirs.id, randomUUID()] })

      expect(response.status).toBe(OK)
      expect(response.body).toEqual({ updated: 1 })
      expect(again.body).toEqual({ updated: 0 })
      expect(strangers.status).toBe(NOT_FOUND)
      // The row already read keeps the moment it was read; the one of someone else stays unread
      expect(
        (await owner.notification.findUniqueOrThrow({ where: { id: alreadyRead.id } })).readAt
      ).toEqual(new Date(0))
      expect(
        (await owner.notification.findUniqueOrThrow({ where: { id: theirs.id } })).readAt
      ).toBeNull()
    })

    it('refuses an empty list of ids and too many', async () => {
      for (const ids of [[], Array.from({ length: 101 }, () => randomUUID()), ['not-an-id']]) {
        const response = await asAdmin().post(ApiRoutes.notifications.markRead).send({ ids })
        expect(response.status).toBe(BAD_REQUEST)
      }
    })

    it('marks every unread row of the user in the store, and no other', async () => {
      await make(ctx.adminA.id)
      await make(ctx.adminA.id)
      const other = await make(ctx.agentA.id)

      const response = await asAdmin().post(ApiRoutes.notifications.markAllRead).send({})

      expect(response.body).toEqual({ updated: 2 })
      expect(
        (await owner.notification.findUniqueOrThrow({ where: { id: other.id } })).readAt
      ).toBeNull()
    })
  })

  describe('sending', () => {
    it('saves the row and tells the sockets of the user in that store', async () => {
      const toStoreUser = jest
        .spyOn(app.get(RealtimeService, { strict: false }), 'toStoreUser')
        .mockImplementation(() => undefined)

      await service.send({
        userId: ctx.adminA.id,
        storeId: ctx.storeA.id,
        type: NotificationTypes.CONVERSATION_ASSIGNED,
        params: { customerName: 'Ana' }
      })

      const row = await owner.notification.findFirstOrThrow({ where: { userId: ctx.adminA.id } })
      expect(row).toMatchObject({
        storeId: ctx.storeA.id,
        type: NotificationTypes.CONVERSATION_ASSIGNED,
        severity: NotificationSeverity.INFO,
        messageKey: 'notifications.conversation.assigned',
        params: { customerName: 'Ana' },
        readAt: null
      })
      expect(toStoreUser).toHaveBeenCalledWith(
        ctx.storeA.id,
        ctx.adminA.id,
        RealtimeEvents.NOTIFICATION,
        expect.objectContaining({ id: row.id, sound: true, params: { customerName: 'Ana' } })
      )
    })

    it('keeps the row but sends nothing live when the user turned in-app off for the type', async () => {
      const toStoreUser = jest
        .spyOn(app.get(RealtimeService, { strict: false }), 'toStoreUser')
        .mockImplementation(() => undefined)
      await owner.notificationPreference.create({
        data: {
          userId: ctx.adminA.id,
          storeId: ctx.storeA.id,
          type: NotificationTypes.CONVERSATION_ASSIGNED,
          inApp: false,
          push: false,
          email: false,
          sound: false
        }
      })

      await service.send({
        userId: ctx.adminA.id,
        storeId: ctx.storeA.id,
        type: NotificationTypes.CONVERSATION_ASSIGNED
      })

      expect(await owner.notification.count({ where: { userId: ctx.adminA.id } })).toBe(1)
      expect(toStoreUser).not.toHaveBeenCalled()
    })

    it('holds back the sound in quiet hours, and still saves and sends the notification', async () => {
      const toStoreUser = jest
        .spyOn(app.get(RealtimeService, { strict: false }), 'toStoreUser')
        .mockImplementation(() => undefined)
      // The two hours that start with the current one, on the clock of UTC
      const hour = new Date().getUTCHours()
      await owner.userNotificationSettings.create({
        data: {
          userId: ctx.adminA.id,
          quietHoursEnabled: true,
          quietHoursStart: hour,
          quietHoursEnd: (hour + 2) % 24,
          timezone: 'UTC'
        }
      })

      await service.send({
        userId: ctx.adminA.id,
        storeId: ctx.storeA.id,
        type: NotificationTypes.CONVERSATION_ASSIGNED
      })

      expect(await owner.notification.count({ where: { userId: ctx.adminA.id } })).toBe(1)
      expect(toStoreUser).toHaveBeenCalledWith(
        ctx.storeA.id,
        ctx.adminA.id,
        RealtimeEvents.NOTIFICATION,
        expect.objectContaining({ sound: false })
      )
    })

    it('saves the notification even when the quiet hours cannot be read', async () => {
      jest
        .spyOn(app.get(RealtimeService, { strict: false }), 'toStoreUser')
        .mockImplementation(() => undefined)
      // A timezone the database accepts but the runtime does not know
      await owner.userNotificationSettings.create({
        data: { userId: ctx.adminA.id, quietHoursEnabled: true, timezone: 'Mars/Olympus' }
      })

      await service.send({
        userId: ctx.adminA.id,
        storeId: ctx.storeA.id,
        type: NotificationTypes.CONVERSATION_ASSIGNED
      })

      expect(await owner.notification.count({ where: { userId: ctx.adminA.id } })).toBe(1)
    })

    it('follows the business hours of the store: quiet while it is closed, never without hours', async () => {
      const toStoreUser = jest
        .spyOn(app.get(RealtimeService, { strict: false }), 'toStoreUser')
        .mockImplementation(() => undefined)
      await owner.userNotificationSettings.create({
        data: { userId: ctx.adminA.id, quietHoursEnabled: true, quietHoursFollowStore: true }
      })
      const send = (): Promise<void> =>
        service.send({
          userId: ctx.adminA.id,
          storeId: ctx.storeA.id,
          type: NotificationTypes.CONVERSATION_ASSIGNED
        })
      const lastSound = (): boolean =>
        (toStoreUser.mock.calls.at(-1)?.[3] as { sound: boolean }).sound

      await owner.businessHours.deleteMany({ where: { storeId: ctx.storeA.id } })
      await send()
      expect(lastSound()).toBe(true) // no hours set: never closed

      await owner.businessHours.create({
        data: {
          storeId: ctx.storeA.id,
          timezone: 'UTC',
          schedule: { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] }
        }
      })
      await send()
      expect(lastSound()).toBe(false) // closed all week
      await owner.businessHours.deleteMany({ where: { storeId: ctx.storeA.id } })
    })

    describe('web push', () => {
      const assigned = {
        userId: '',
        storeId: '',
        type: NotificationTypes.CONVERSATION_ASSIGNED
      }
      const sendAssigned = (): Promise<void> =>
        service.send({ ...assigned, userId: ctx.adminA.id, storeId: ctx.storeA.id })

      beforeEach(async () => {
        jest
          .spyOn(app.get(RealtimeService, { strict: false }), 'toStoreUser')
          .mockImplementation(() => undefined)
        await owner.pushSubscription.create({
          data: {
            userId: ctx.adminA.id,
            endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`,
            p256dh: 'k',
            auth: 'a'
          }
        })
      })

      it('queues nothing for a person with no browser registered', async () => {
        await owner.pushSubscription.deleteMany({ where: { userId: ctx.adminA.id } })
        await sendAssigned()
        expect(pushQueue.jobs).toEqual([])
      })

      it('queues one job for the notification, named after it', async () => {
        await sendAssigned()

        const row = await owner.notification.findFirstOrThrow({ where: { userId: ctx.adminA.id } })
        expect(pushQueue.jobs).toEqual([
          {
            name: JobNames.SEND_WEB_PUSH,
            data: { userId: ctx.adminA.id, notificationId: row.id },
            opts: { jobId: `${JobNames.SEND_WEB_PUSH}-${row.id}` }
          }
        ])
      })

      it('queues nothing for a type that has no push, or that the user turned off', async () => {
        await service.send({
          userId: ctx.adminA.id,
          storeId: ctx.storeA.id,
          type: NotificationTypes.EXPORT_READY
        })
        await owner.notificationPreference.create({
          data: {
            userId: ctx.adminA.id,
            storeId: ctx.storeA.id,
            type: NotificationTypes.CONVERSATION_ASSIGNED,
            inApp: true,
            push: false,
            email: false,
            sound: true
          }
        })
        await sendAssigned()

        expect(pushQueue.jobs).toEqual([])
      })

      it('queues nothing in quiet hours, and still queues without the in-app event', async () => {
        const hour = new Date().getUTCHours()
        await owner.userNotificationSettings.create({
          data: {
            userId: ctx.adminA.id,
            quietHoursEnabled: true,
            quietHoursStart: hour,
            quietHoursEnd: (hour + 2) % 24,
            timezone: 'UTC'
          }
        })
        await sendAssigned()
        expect(pushQueue.jobs).toEqual([])

        await owner.userNotificationSettings.deleteMany({ where: { userId: ctx.adminA.id } })
        await owner.notificationPreference.create({
          data: {
            userId: ctx.adminA.id,
            storeId: ctx.storeA.id,
            type: NotificationTypes.CONVERSATION_ASSIGNED,
            inApp: false,
            push: true,
            email: false,
            sound: false
          }
        })
        await sendAssigned()
        expect(pushQueue.jobs).toHaveLength(1)
      })

      it('keeps the notification when the queue is down', async () => {
        jest.spyOn(pushQueue, 'add').mockRejectedValueOnce(new Error('redis is down'))

        await expect(sendAssigned()).resolves.toBeUndefined()

        expect(await owner.notification.count({ where: { userId: ctx.adminA.id } })).toBe(1)
      })
    })

    describe('email', () => {
      const sendMentioned = (): Promise<void> =>
        service.send({
          userId: ctx.adminA.id,
          storeId: ctx.storeA.id,
          type: NotificationTypes.CONVERSATION_MENTIONED
        })

      beforeEach(() => {
        jest
          .spyOn(app.get(RealtimeService, { strict: false }), 'toStoreUser')
          .mockImplementation(() => undefined)
      })

      const chooseDigest = (digestFrequency: DigestFrequency): Promise<unknown> =>
        owner.userNotificationSettings.create({ data: { userId: ctx.adminA.id, digestFrequency } })
      const emailJobs = (): unknown[] =>
        pushQueue.jobs.filter(job => job.name === JobNames.QUEUE_EMAIL_DIGEST)

      it('marks the row and queues one job named after it for the immediate kind', async () => {
        await chooseDigest(DigestFrequency.IMMEDIATE)
        await sendMentioned()

        const row = await owner.notification.findFirstOrThrow({ where: { userId: ctx.adminA.id } })
        expect(row.emailPendingAt).toBeInstanceOf(Date)
        expect(pushQueue.jobs).toContainEqual({
          name: JobNames.QUEUE_EMAIL_DIGEST,
          data: { userId: ctx.adminA.id, notificationId: row.id },
          opts: { jobId: `${JobNames.QUEUE_EMAIL_DIGEST}-${row.id}` }
        })
      })

      it.each([DigestFrequency.HOURLY, DigestFrequency.DAILY])(
        'marks the row and queues no job for a %s digest, which the scheduler finds by the mark',
        async frequency => {
          await chooseDigest(frequency)
          await sendMentioned()

          const row = await owner.notification.findFirstOrThrow({
            where: { userId: ctx.adminA.id }
          })
          expect(row.emailPendingAt).toBeInstanceOf(Date)
          expect(emailJobs()).toEqual([])
        }
      )

      it('marks and queues nothing when the digest is switched off', async () => {
        await chooseDigest(DigestFrequency.OFF)
        await sendMentioned()

        const row = await owner.notification.findFirstOrThrow({ where: { userId: ctx.adminA.id } })
        expect(row.emailPendingAt).toBeNull()
        expect(emailJobs()).toEqual([])
      })

      it('marks and queues nothing for a type with no email, or one the user turned off', async () => {
        await service.send({
          userId: ctx.adminA.id,
          storeId: ctx.storeA.id,
          type: NotificationTypes.CONVERSATION_ASSIGNED
        })
        await owner.notificationPreference.create({
          data: {
            userId: ctx.adminA.id,
            storeId: ctx.storeA.id,
            type: NotificationTypes.CONVERSATION_MENTIONED,
            inApp: true,
            push: false,
            email: false,
            sound: false
          }
        })
        await sendMentioned()

        const rows = await owner.notification.findMany({ where: { userId: ctx.adminA.id } })
        expect(rows.map(row => row.emailPendingAt)).toEqual([null, null])
        expect(pushQueue.jobs.filter(job => job.name === JobNames.QUEUE_EMAIL_DIGEST)).toEqual([])
      })

      it('does not hold the email back in quiet hours', async () => {
        const hour = new Date().getUTCHours()
        await owner.userNotificationSettings.create({
          data: {
            userId: ctx.adminA.id,
            quietHoursEnabled: true,
            quietHoursStart: hour,
            quietHoursEnd: (hour + 2) % 24,
            timezone: 'UTC'
          }
        })
        await sendMentioned()

        const row = await owner.notification.findFirstOrThrow({ where: { userId: ctx.adminA.id } })
        expect(row.emailPendingAt).toBeInstanceOf(Date)
      })

      it('keeps the row, and its mark, when the queue is down', async () => {
        await chooseDigest(DigestFrequency.IMMEDIATE)
        jest.spyOn(pushQueue, 'add').mockRejectedValue(new Error('redis is down'))

        await expect(sendMentioned()).resolves.toBeUndefined()

        const row = await owner.notification.findFirstOrThrow({ where: { userId: ctx.adminA.id } })
        expect(row.emailPendingAt).toBeInstanceOf(Date)
      })
    })

    it('sends to the members of a store who hold the permission, except the excluded', async () => {
      jest
        .spyOn(app.get(RealtimeService, { strict: false }), 'toStoreUser')
        .mockImplementation(() => undefined)
      const recipients = async (): Promise<string[]> =>
        (
          await owner.notification.findMany({
            where: { storeId: ctx.storeA.id },
            select: { userId: true }
          })
        ).map(row => row.userId)

      await service.sendToStore({
        storeId: ctx.storeA.id,
        type: NotificationTypes.EXPORT_READY,
        requiredPermission: Permissions.TEAM_MANAGE_ROLES
      })
      expect(await recipients()).toEqual([ctx.adminA.id])

      await owner.notification.deleteMany({ where: { userId: ctx.adminA.id } })
      await service.sendToStore({
        storeId: ctx.storeA.id,
        type: NotificationTypes.EXPORT_READY,
        requiredPermission: Permissions.TEAM_MANAGE_ROLES,
        excludeUserIds: [ctx.adminA.id]
      })
      expect(await recipients()).toEqual([])

      await service.sendToStore({ storeId: ctx.storeA.id, type: NotificationTypes.EXPORT_READY })
      expect((await recipients()).sort()).toEqual(
        [ctx.adminA.id, ctx.agentA.id, ctx.viewerA.id].sort()
      )
    })
  })

  describe('the preferences', () => {
    it('start as the default matrix, and the user settings as their defaults', async () => {
      const response = await asAdmin().get(ApiRoutes.notifications.preferences)
      const body = response.body as PreferencesBody

      expect(response.status).toBe(OK)
      expect(body.types).toHaveLength(Object.keys(NotificationTypes).length)
      expect(body.types.find(row => row.type === NotificationTypes.CONVERSATION_ASSIGNED)).toEqual(
        expect.objectContaining({ inApp: true, push: true, email: false, sound: true })
      )
      expect(body.settings).toMatchObject({
        quietHoursEnabled: false,
        quietHoursStart: 22,
        quietHoursEnd: 7,
        digestFrequency: DigestFrequency.HOURLY
      })
    })

    it('change per type for the store of the header and per user for the settings', async () => {
      const response = await asAdmin()
        .put(ApiRoutes.notifications.preferences)
        .send({
          types: [
            {
              type: NotificationTypes.CONVERSATION_ASSIGNED,
              inApp: true,
              push: false,
              email: true,
              sound: false
            }
          ],
          settings: { quietHoursEnabled: true, digestFrequency: DigestFrequency.DAILY }
        })
      const body = response.body as PreferencesBody

      expect(response.status).toBe(OK)
      expect(body.types.find(row => row.type === NotificationTypes.CONVERSATION_ASSIGNED)).toEqual(
        expect.objectContaining({ push: false, email: true, sound: false })
      )
      expect(body.settings).toMatchObject({
        quietHoursEnabled: true,
        quietHoursStart: 22,
        digestFrequency: DigestFrequency.DAILY
      })
      // Another store of the same user is not touched
      expect(
        await owner.notificationPreference.count({
          where: { userId: ctx.adminA.id, storeId: ctx.storeA2.id }
        })
      ).toBe(0)
    })

    it('refuse a bad body as a whole', async () => {
      const bad = [
        {},
        { types: [], storeId: ctx.storeB.id },
        { types: [{ type: 'made.up', inApp: true, push: true, email: true, sound: true }] },
        {
          types: [
            {
              type: NotificationTypes.EXPORT_READY,
              inApp: true,
              push: true,
              email: true,
              sound: true
            },
            {
              type: NotificationTypes.EXPORT_READY,
              inApp: true,
              push: true,
              email: true,
              sound: true
            }
          ]
        },
        { settings: {} },
        { settings: { quietHoursStart: 24 } },
        { settings: { timezone: 'Mars/Olympus' } },
        { settings: { digestFrequency: 'weekly' } }
      ]
      for (const body of bad) {
        const response = await asAdmin().put(ApiRoutes.notifications.preferences).send(body)
        expect(response.status).toBe(BAD_REQUEST)
      }
      expect(await owner.notificationPreference.count({ where: { userId: ctx.adminA.id } })).toBe(0)
    })
  })

  describe('push subscriptions', () => {
    const endpoint = (): string => `https://fcm.googleapis.com/fcm/send/${randomUUID()}`
    const body = (url: string, extra: Record<string, unknown> = {}) => ({
      endpoint: url,
      p256dh: P256DH,
      auth: AUTH,
      ...extra
    })
    const register = (url: string, extra?: Record<string, unknown>) =>
      asAdmin().post(ApiRoutes.notifications.pushSubscription).send(body(url, extra))
    const unregister = (as: ReturnType<typeof asAdmin>, url: string) =>
      as.post(ApiRoutes.notifications.pushSubscriptionRemove).send({ endpoint: url })

    it('registers a browser of the user, and registering it again changes nothing but its keys', async () => {
      const url = endpoint()

      const first = await register(url, { userAgent: 'Firefox' })
      const again = await asAdmin()
        .post(ApiRoutes.notifications.pushSubscription)
        .send({ endpoint: url, p256dh: P256DH_NEW, auth: AUTH_NEW })

      expect(first.status).toBe(NO_CONTENT)
      expect(again.status).toBe(NO_CONTENT)
      const rows = await owner.pushSubscription.findMany({ where: { endpoint: url } })
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ userId: ctx.adminA.id, p256dh: P256DH_NEW, auth: AUTH_NEW })
    })

    it('moves the browser to the next person who signs in on it', async () => {
      const url = endpoint()
      await register(url)

      await api(app, ctx.agentA, ctx.storeA)
        .post(ApiRoutes.notifications.pushSubscription)
        .send(body(url))

      const rows = await owner.pushSubscription.findMany({ where: { endpoint: url } })
      expect(rows.map(row => row.userId)).toEqual([ctx.agentA.id])
    })

    it('refuses an endpoint that is not the host of a push service, and a field it does not know', async () => {
      const bad = [
        body('http://fcm.googleapis.com/fcm/send/x'),
        body('https://169.254.169.254/latest/meta-data'),
        body('https://fcm.googleapis.com.attacker.example/push'),
        body('not a url'),
        { ...body(endpoint()), p256dh: '' },
        { ...body(endpoint()), p256dh: 'short' },
        { ...body(endpoint()), auth: 'not base64url!' + 'a'.repeat(8) },
        { ...body(endpoint()), userId: ctx.agentA.id }
      ]
      for (const payload of bad) {
        const response = await asAdmin()
          .post(ApiRoutes.notifications.pushSubscription)
          .send(payload)
        expect(response.status).toBe(BAD_REQUEST)
        expect((response.body as ErrorBody).error.code).toBe(ErrorCodes.VALIDATION_FAILED)
      }
      expect(await owner.pushSubscription.count({ where: { userId: ctx.adminA.id } })).toBe(0)
    })

    it('keeps the newest browsers up to the limit', async () => {
      const urls = Array.from({ length: PushLimits.MAX_SUBSCRIPTIONS_PER_USER + 1 }, endpoint)
      for (const url of urls) await register(url)

      const kept = await owner.pushSubscription.findMany({ where: { userId: ctx.adminA.id } })
      expect(kept).toHaveLength(PushLimits.MAX_SUBSCRIPTIONS_PER_USER)
      expect(kept.map(row => row.endpoint)).not.toContain(urls[0])
    })

    it('removes the own browser, and answers the same for one that is someone else’s or unknown', async () => {
      const mine = endpoint()
      const theirs = endpoint()
      await register(mine)
      await owner.pushSubscription.create({
        data: { userId: ctx.agentA.id, endpoint: theirs, p256dh: 'k', auth: 'a' }
      })

      const own = await unregister(asAdmin(), mine)
      const foreign = await unregister(asAdmin(), theirs)
      const unknown = await unregister(asAdmin(), endpoint())

      expect([own.status, foreign.status, unknown.status]).toEqual([
        NO_CONTENT,
        NO_CONTENT,
        NO_CONTENT
      ])
      expect(await owner.pushSubscription.count({ where: { endpoint: mine } })).toBe(0)
      expect(await owner.pushSubscription.count({ where: { endpoint: theirs } })).toBe(1)
    })

    it('answers a member whose role holds no permission at all', async () => {
      const response = await api(app, ctx.viewerA, ctx.storeA)
        .post(ApiRoutes.notifications.pushSubscription)
        .send(body(endpoint()))

      expect(response.status).toBe(NO_CONTENT)
    })
  })
})
