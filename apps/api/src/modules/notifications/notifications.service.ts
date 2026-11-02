import { Injectable, Logger } from '@nestjs/common'

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
  NotificationTypes
} from '@platform/core/notifications'
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
// the preferences and quiet hours only decide what else happens (the live event now; web push and the
// email digest are Steps 3.5 PR C and D, which add their jobs here).
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly preferences: NotificationPreferencesService
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

    // Quiet hours hold back sound (and push, when it exists). If they cannot be read (a timezone the
    // runtime does not know) the sound plays: a missed alert is worse than an unwanted one
    const quiet = prefs.push || prefs.sound ? await this.isQuiet(input) : false
    const sound = prefs.sound && !quiet

    if (!prefs.inApp) return
    const payload: NotificationRealtimePayload = {
      id: row.id,
      type: input.type,
      severity: defaults.severity,
      messageKey: row.messageKey,
      params: input.params ?? {},
      actionPath: row.actionPath,
      sound,
      createdAt: row.createdAt.toISOString()
    }
    this.realtime.toStoreUser(input.storeId, input.userId, RealtimeEvents.NOTIFICATION, payload)
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
    // One failing recipient must not take the others with it
    const results = await Promise.allSettled(
      members.map(member => this.send({ ...rest, userId: member.userId }))
    )
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
