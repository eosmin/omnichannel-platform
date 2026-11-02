import { randomUUID } from 'node:crypto'

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
  notificationMessageKey
} from '@platform/core/notifications'
import { RealtimeEvents } from '@platform/core/realtime'

import { NotificationsService } from '../../apps/api/src/modules/notifications/notifications.service'
import { RealtimeService } from '../../apps/api/src/modules/realtime/realtime.service'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

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

// The notifications of a member in a store: the center (list, count, read) and the preferences that
// decide what else is done with one (TDD_06 §6, §9).
describe('Notifications', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let service: NotificationsService

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
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
})
