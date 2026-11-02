import { Injectable } from '@nestjs/common'

import { PrismaService } from '@platform/core/database'
import { isWithinSchedule, NotificationChannel, weekScheduleSchema } from '@platform/core/domain'
import {
  isInQuietRange,
  NotificationDefaults,
  NotificationSettingsDefaults,
  type NotificationType,
  NotificationTypes
} from '@platform/core/notifications'

import type { PutPreferencesBody } from './notifications.schemas'
import type { NotificationSettingsView, PreferencesView } from './notifications.views'

export interface ChannelPreference {
  inApp: boolean
  push: boolean
  email: boolean
  sound: boolean
}

const SETTINGS_COLUMNS = {
  quietHoursEnabled: true,
  quietHoursStart: true,
  quietHoursEnd: true,
  quietHoursFollowStore: true,
  timezone: true,
  digestFrequency: true,
  crossStoreEnabled: true,
  crossStoreSupervisorOnly: true
} as const

// The factory choice of a type (TDD_06 §6.1): the matrix the preferences page draws
function defaultsOf(type: NotificationType): ChannelPreference {
  const { channels } = NotificationDefaults[type]
  return {
    inApp: channels.includes(NotificationChannel.IN_APP),
    push: channels.includes(NotificationChannel.PUSH),
    email: channels.includes(NotificationChannel.EMAIL),
    sound: channels.includes(NotificationChannel.SOUND)
  }
}

// What a person chose for the notifications they get (TDD_06 §9): per type and store, and the settings
// that are theirs in every store. A choice never made falls back to the defaults.
@Injectable()
export class NotificationPreferencesService {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(
    userId: string,
    storeId: string,
    type: NotificationType
  ): Promise<ChannelPreference> {
    const row = await this.prisma.client.notificationPreference.findUnique({
      where: { userId_storeId_type: { userId, storeId, type } },
      select: { inApp: true, push: true, email: true, sound: true }
    })
    return row ?? defaultsOf(type)
  }

  async settingsOf(userId: string): Promise<NotificationSettingsView> {
    const row = await this.prisma.client.userNotificationSettings.findUnique({
      where: { userId },
      select: SETTINGS_COLUMNS
    })
    return (row as NotificationSettingsView | null) ?? { ...NotificationSettingsDefaults }
  }

  // Quiet hours hold back push and sound, never the notification itself. Following the store means
  // quiet while the store is closed; a store with no hours, or hours that cannot be read, is never closed.
  async isInQuietHours(userId: string, storeId: string, at = new Date()): Promise<boolean> {
    const settings = await this.settingsOf(userId)
    if (!settings.quietHoursEnabled) return false

    if (settings.quietHoursFollowStore) {
      const hours = await this.prisma.client.businessHours.findUnique({
        where: { storeId },
        select: { timezone: true, schedule: true }
      })
      if (hours === null) return false
      const schedule = weekScheduleSchema.safeParse(hours.schedule)
      if (!schedule.success) return false
      return !isWithinSchedule(schedule.data, hours.timezone, at)
    }

    return isInQuietRange(
      {
        start: settings.quietHoursStart,
        end: settings.quietHoursEnd,
        timezone: settings.timezone
      },
      at
    )
  }

  async get(userId: string, storeId: string): Promise<PreferencesView> {
    const [rows, settings] = await Promise.all([
      this.prisma.client.notificationPreference.findMany({
        where: { userId, storeId },
        select: { type: true, inApp: true, push: true, email: true, sound: true }
      }),
      this.settingsOf(userId)
    ])
    const chosen = new Map(rows.map(row => [row.type, row]))
    return {
      types: Object.values(NotificationTypes).map(type => ({
        type,
        severity: NotificationDefaults[type].severity,
        ...(chosen.get(type) ?? defaultsOf(type))
      })),
      settings
    }
  }

  async put(userId: string, storeId: string, body: PutPreferencesBody): Promise<PreferencesView> {
    await this.prisma.transaction(async tx => {
      for (const { type, ...channels } of body.types ?? []) {
        await tx.notificationPreference.upsert({
          where: { userId_storeId_type: { userId, storeId, type } },
          create: { userId, storeId, type, ...channels },
          update: channels
        })
      }
      if (body.settings !== undefined && Object.keys(body.settings).length > 0) {
        await tx.userNotificationSettings.upsert({
          where: { userId },
          create: { userId, ...body.settings },
          update: body.settings
        })
      }
    })
    return this.get(userId, storeId)
  }
}
