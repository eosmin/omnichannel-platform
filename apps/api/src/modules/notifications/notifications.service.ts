import { InjectQueue } from '@nestjs/bullmq'
import { Injectable, Logger } from '@nestjs/common'
import type { Queue } from 'bullmq'

import { type Permission } from '@platform/core/auth'
import { PrismaService } from '@platform/core/database'
import { MembershipStatus, type CursorPage } from '@platform/core/domain'
import { resourceNotFound } from '@platform/core/errors'
import {
  NotificationDefaults,
  NotificationFilters,
  NotificationLimits,
  notificationMessageKey,
  type NotificationRealtimePayload,
  type NotificationType,
  NotificationTypes,
  PushLimits
} from '@platform/core/notifications'
import { JobNames, QueueNames, type SendWebPushJob } from '@platform/core/queues'
import { RealtimeEvents } from '@platform/core/realtime'

import { encodeCursor } from '../customers/list-cursor'
import { RealtimeService } from '../realtime/realtime.service'

import { NotificationPreferencesService } from './notification-preferences.service'
import type { ListNotificationsQuery } from './notifications.schemas'
import {
  NOTIFICATION_COLUMNS,
  notificationView,
  type NotificationView
} from './notifications.views'

export type NotificationParams = Record<string, string | number>

export interface SendNotification {
  userId: string
  storeId: string
  type: NotificationType
  params?: NotificationParams // Filled into the i18n message when it is shown
  resourceType?: string
  resourceId?: string
  actionPath?: string // Built with AppPaths, never a literal
}

export interface SendNotificationToStore extends Omit<SendNotification, 'userId'> {
  excludeUserIds?: readonly string[]
  requiredPermission?: Permission
}

// The notifications of a person in a store (TDD_06 §6). Every row is saved, so that the center shows it;
// the preferences and quiet hours only decide what else happens: the live event, the web push, and
// (Step 3.5 PR D, which adds its job here) the email digest.
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly preferences: NotificationPreferencesService,
    @InjectQueue(QueueNames.NOTIFICATIONS) private readonly queue: Queue<SendWebPushJob>
  ) {}

  async send(input: SendNotification): Promise<void> {
    const defaults = NotificationDefaults[input.type]
    const prefs = await this.preferences.resolve(input.userId, input.storeId, input.type)

    // Saved first and always: nothing about quiet hours may stop it from reaching the center
    const row = await this.prisma.client.notification.create({
      data: {
        userId: input.userId,
        storeId: input.storeId,
        type: input.type,
        severity: defaults.severity,
        messageKey: notificationMessageKey(input.type),
        params: input.params ?? {},
        resourceType: input.resourceType ?? null,
        resourceId: input.resourceId ?? null,
        actionPath: input.actionPath ?? null
      },
      select: { id: true, messageKey: true, actionPath: true, createdAt: true }
    })

    // Quiet hours hold back sound and push. If they cannot be read (a timezone the runtime does not
    // know) both are sent: a missed alert is worse than an unwanted one
    const quiet = prefs.push || prefs.sound ? await this.isQuiet(input) : false
    const sound = prefs.sound && !quiet

    if (prefs.inApp) this.emitLive(input, row, defaults.severity, sound)
    if (prefs.push && !quiet) await this.queueWebPush(input.userId, row.id)
  }

  private emitLive(
    input: SendNotification,
    row: { id: string; messageKey: string; actionPath: string | null; createdAt: Date },
    severity: NotificationRealtimePayload['severity'],
    sound: boolean
  ): void {
    const payload: NotificationRealtimePayload = {
      id: row.id,
      type: input.type,
      severity,
      messageKey: row.messageKey,
      params: input.params ?? {},
      actionPath: row.actionPath,
      sound,
      createdAt: row.createdAt.toISOString()
    }
    this.realtime.toStoreUser(input.storeId, input.userId, RealtimeEvents.NOTIFICATION, payload)
  }

  // One job per notification, so a retry of the event that raised it pushes once. The row is saved:
  // a queue that is down costs the push and never the action that raised the notification.
  private async queueWebPush(userId: string, notificationId: string): Promise<void> {
    try {
      // Nobody to push to: no job, no Redis write, no read in the worker
      const browser = await this.prisma.client.pushSubscription.findFirst({
        where: { userId },
        select: { id: true }
      })
      if (browser === null) return
      // Redis down makes the queue wait instead of fail: the action is not held for a push
      let timer: NodeJS.Timeout | undefined
      try {
        await Promise.race([
          this.queue.add(
            JobNames.SEND_WEB_PUSH,
            { userId, notificationId },
            { jobId: `${JobNames.SEND_WEB_PUSH}-${notificationId}` }
          ),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error('the queue did not answer')),
              PushLimits.ENQUEUE_TIMEOUT_MS
            )
          })
        ])
      } finally {
        clearTimeout(timer)
      }
    } catch (error) {
      this.logger.warn(
        { userId, notificationId, err: String(error) },
        'web push could not be queued'
      )
    }
  }

  private async isQuiet(input: SendNotification): Promise<boolean> {
    try {
      return await this.preferences.isInQuietHours(input.userId, input.storeId)
    } catch (error) {
      this.logger.warn(
        { userId: input.userId, storeId: input.storeId, err: String(error) },
        'quiet hours could not be read: treated as not quiet'
      )
      return false
    }
  }

  // Everyone active in the store, who holds the permission when one is named
  async sendToStore(input: SendNotificationToStore): Promise<void> {
    const { excludeUserIds, requiredPermission, ...rest } = input
    const members = await this.prisma.client.membership.findMany({
      where: {
        storeId: input.storeId,
        status: MembershipStatus.ACTIVE,
        ...(excludeUserIds === undefined ? {} : { userId: { notIn: [...excludeUserIds] } }),
        ...(requiredPermission === undefined
          ? {}
          : { role: { permissions: { some: { name: requiredPermission } } } })
      },
      select: { userId: true }
    })
    await this.sendToUsers(
      members.map(member => member.userId),
      rest
    )
  }

  // The same notification to each of these people (already checked to be allowed to see it)
  async sendToUsers(
    userIds: readonly string[],
    input: Omit<SendNotification, 'userId'>
  ): Promise<void> {
    // One failing recipient must not take the others with it
    const results = await Promise.allSettled(userIds.map(userId => this.send({ ...input, userId })))
    const failed = results.find(result => result.status === 'rejected')
    if (failed !== undefined) throw failed.reason
  }

  async list(
    userId: string,
    storeId: string,
    query: ListNotificationsQuery
  ): Promise<CursorPage<NotificationView>> {
    const { cursor } = query
    const rows = await this.prisma.client.notification.findMany({
      where: {
        userId,
        storeId,
        ...(query.filter === NotificationFilters.UNREAD ? { readAt: null } : {}),
        ...(query.filter === NotificationFilters.MENTIONS
          ? { type: NotificationTypes.CONVERSATION_MENTIONED }
          : {}),
        ...(cursor === undefined
          ? {}
          : {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } }
              ]
            })
      },
      select: NOTIFICATION_COLUMNS,
      take: query.limit + 1,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
    })
    const hasMore = rows.length > query.limit
    const page = hasMore ? rows.slice(0, query.limit) : rows
    const last = page.at(-1)
    return {
      data: page.map(notificationView),
      nextCursor: hasMore && last !== undefined ? encodeCursor(last) : null,
      hasMore
    }
  }

  unreadCount(userId: string, storeId: string): Promise<number> {
    // Capped: the badge shows "99+" past NotificationLimits.BADGE_CAP, so counting further is wasted work
    return this.prisma.client.notification.count({
      where: { userId, storeId, readAt: null },
      take: NotificationLimits.BADGE_CAP + 1
    })
  }

  // Only the rows of this user in this store. Ids that are not theirs are skipped, but a call where none
  // is theirs is a 404, the answer of an id that exists nowhere: it does not tell whether one exists.
  // A row already read stays as it was, so asking twice is harmless.
  async markRead(userId: string, storeId: string, ids: readonly string[]): Promise<number> {
    const owned = await this.prisma.client.notification.findMany({
      where: { id: { in: [...ids] }, userId, storeId },
      select: { id: true }
    })
    if (owned.length === 0) throw resourceNotFound('notification')
    const { count } = await this.prisma.client.notification.updateMany({
      where: { id: { in: owned.map(row => row.id) }, userId, storeId, readAt: null },
      data: { readAt: new Date() }
    })
    return count
  }

  async markAllRead(userId: string, storeId: string): Promise<number> {
    const { count } = await this.prisma.client.notification.updateMany({
      where: { userId, storeId, readAt: null },
      data: { readAt: new Date() }
    })
    return count
  }
}
