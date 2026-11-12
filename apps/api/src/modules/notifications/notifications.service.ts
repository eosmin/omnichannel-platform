import { InjectQueue } from '@nestjs/bullmq'
import { Injectable, Logger } from '@nestjs/common'
import type { Queue } from 'bullmq'

import { type Permission } from '@platform/core/auth'
import { PrismaService } from '@platform/core/database'
import { DigestFrequency, MembershipStatus, type CursorPage } from '@platform/core/domain'
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
import {
  JobNames,
  type QueueEmailDigestJob,
  QueueNames,
  type SendWebPushJob
} from '@platform/core/queues'
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
  // Only the center: no sound, no push and no email. For what happened a while ago and is told now (the replay of an event the
  // owner mapped late): it is written, never shouted
  inAppOnly?: boolean
}

export interface SendNotificationToStore extends Omit<SendNotification, 'userId'> {
  excludeUserIds?: readonly string[]
  requiredPermission?: Permission
}

// The notifications of a person in a store (TDD_06 §6). Every row is saved, so that the center shows it;
// the preferences and quiet hours only decide what else happens: the live event, the web push, and
// the email (a mark on the row that the digest of the worker reads, and a job for the immediate kind).
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly preferences: NotificationPreferencesService,
    @InjectQueue(QueueNames.NOTIFICATIONS)
    private readonly queue: Queue<SendWebPushJob | QueueEmailDigestJob>
  ) {}

  async send(input: SendNotification): Promise<void> {
    const defaults = NotificationDefaults[input.type]
    const resolved = await this.preferences.resolve(input.userId, input.storeId, input.type)
    const prefs =
      input.inAppOnly === true ? { ...resolved, push: false, sound: false, email: false } : resolved
    // The email is wanted only if the type has it on and the person did not switch the digest off;
    // the settings are read only for a type that has it, so the rest pays nothing for them
    const frequency = prefs.email
      ? (await this.preferences.settingsOf(input.userId)).digestFrequency
      : DigestFrequency.OFF
    const emailWanted = frequency !== DigestFrequency.OFF

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
        actionPath: input.actionPath ?? null,
        emailPendingAt: emailWanted ? new Date() : null
      },
      select: { id: true, messageKey: true, actionPath: true, createdAt: true }
    })

    // Quiet hours hold back sound and push. If they cannot be read (a timezone the runtime does not
    // know) both are sent: a missed alert is worse than an unwanted one
    const quiet = prefs.push || prefs.sound ? await this.isQuiet(input) : false
    const sound = prefs.sound && !quiet

    if (prefs.inApp) this.emitLive(input, row, defaults.severity, sound)
    if (prefs.push && quiet) {
      this.logger.log(
        { userId: input.userId, notificationId: row.id, reason: 'quiet_hours' },
        'a web push was not queued'
      )
    }
    if (prefs.push && !quiet) await this.queueWebPush(input.userId, row.id)
    // Quiet hours do not hold the email back: they pause what makes noise, and a mail is read later.
    // Only the immediate kind needs a job: hourly and daily are found by the scheduler by the mark
    if (frequency === DigestFrequency.IMMEDIATE) await this.queueEmailDigest(input.userId, row.id)
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
      if (browser === null) {
        this.logger.log(
          { userId, notificationId, reason: 'no_subscription' },
          'a web push was not queued'
        )
        return
      }
      await this.enqueue(JobNames.SEND_WEB_PUSH, { userId, notificationId })
    } catch (error) {
      this.logger.warn(
        { userId, notificationId, err: String(error) },
        'web push could not be queued'
      )
    }
  }

  // One job per notification: the email goes at once or waits for the digest, as the person chose.
  // The row carries the mark, so a queue that is down costs only the immediate kind.
  private async queueEmailDigest(userId: string, notificationId: string): Promise<void> {
    try {
      await this.enqueue(JobNames.QUEUE_EMAIL_DIGEST, { userId, notificationId })
    } catch (error) {
      this.logger.warn(
        { userId, notificationId, err: String(error) },
        'the email of a notification could not be queued'
      )
    }
  }

  // Redis down makes the queue wait instead of fail: the action is not held for a job
  private async enqueue(
    name: typeof JobNames.SEND_WEB_PUSH | typeof JobNames.QUEUE_EMAIL_DIGEST,
    data: SendWebPushJob & QueueEmailDigestJob
  ): Promise<void> {
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        this.queue.add(name, data, { jobId: `${name}-${data.notificationId}` }),
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
        revokedAt: null,
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

  // Like sendToUsers, but a person who still has this very notification unread (same type, same
  // resource) is not told again: a burst of messages in one conversation, or a queue that keeps
  // growing, is one line in the center until they look at it. The resource is required for that reason.
  async sendToUsersOnce(
    userIds: readonly string[],
    input: Omit<SendNotification, 'userId' | 'resourceId'> & {
      resourceId: string
      // Other types about the same resource that count as "told already" (an assignment says the
      // conversation is theirs, so the first message of it adds nothing)
      alsoUnread?: readonly NotificationType[]
    }
  ): Promise<void> {
    if (userIds.length === 0) return
    // The check and the write are one step per kind and resource: handlers that run together for a
    // burst of messages must not all find nothing unread and all write
    await this.exclusively(`${input.storeId}:${input.type}:${input.resourceId}`, async () => {
      const { alsoUnread = [], ...notification } = input
      const pending = await this.prisma.client.notification.findMany({
        where: {
          storeId: input.storeId,
          type: { in: [input.type, ...alsoUnread] },
          resourceId: input.resourceId,
          userId: { in: [...userIds] },
          readAt: null,
          createdAt: { gte: new Date(Date.now() - NotificationLimits.DEDUP_WINDOW_MS) }
        },
        select: { userId: true }
      })
      const already = new Set(pending.map(row => row.userId))
      await this.sendToUsers(
        userIds.filter(userId => !already.has(userId)),
        notification
      )
    })
  }

  // One at a time for each key, in this process. The events that make a burst reach one api instance
  // (the worker's bridge goes to one), so this is the whole race; a second instance publishing the
  // same kind at the same moment may still send twice, which costs one extra line and nothing else.
  private readonly queues = new Map<string, Promise<unknown>>()
  private async exclusively(key: string, run: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(key) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(run)
    this.queues.set(key, next)
    try {
      await next
    } finally {
      if (this.queues.get(key) === next) this.queues.delete(key)
    }
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
