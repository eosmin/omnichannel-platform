import { Injectable } from '@nestjs/common'

import { PrismaService } from '@platform/core/database'
import { NotificationChannel } from '@platform/core/domain'
import {
  NotificationDefaults,
  NotificationSettingsDefaults,
  type NotificationType,
  NotificationTypes
} from '@platform/core/notifications'

import type { PutPreferencesBody } from './notifications.schemas'
import type { NotificationSettingsView, PreferencesView } from './notifications.views'
import { isQuietAt, type StoreHours } from './quiet-hours'

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

// What the notifications of a group of people need, read once for the group (`loadRecipients`)
export interface RecipientsContext {
  // What it was read for: another store or type is not served by it
  storeId: string
  type: NotificationType
  channels: ReadonlyMap<string, ChannelPreference>
  settings: ReadonlyMap<string, NotificationSettingsView>
  hours: StoreHours | null
}

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

  // What `resolve` and `settingsOf` answer for many people at once: one read of each table for the whole group, and the hours of the
  // store once, whoever of them follows it. A person with no row gets the same defaults as in the single reads.
  async loadRecipients(
    userIds: readonly string[],
    storeId: string,
    type: NotificationType
  ): Promise<RecipientsContext> {
    const [rows, settingsRows] = await Promise.all([
      this.prisma.client.notificationPreference.findMany({
        where: { storeId, type, userId: { in: [...userIds] } },
        select: { userId: true, inApp: true, push: true, email: true, sound: true }
      }),
      this.prisma.client.userNotificationSettings.findMany({
        where: { userId: { in: [...userIds] } },
        select: { userId: true, ...SETTINGS_COLUMNS }
      })
    ])
    // Everyone is in the maps: whoever chose nothing holds the defaults, so a reader never has to ask twice
    const channels = new Map<string, ChannelPreference>(
      userIds.map(userId => [userId, defaultsOf(type)])
    )
    for (const { userId, ...choice } of rows) channels.set(userId, choice)
    const settings = new Map<string, NotificationSettingsView>(
      userIds.map(userId => [userId, { ...NotificationSettingsDefaults }])
    )
    for (const { userId, ...chosen } of settingsRows) {
      settings.set(userId, chosen as NotificationSettingsView)
    }
    // The hours are read only when someone in the group follows the store
    const followsStore = settingsRows.some(
      row => row.quietHoursEnabled && row.quietHoursFollowStore
    )
    const hours = followsStore ? await this.storeHours(storeId) : null
    return { storeId, type, channels, settings, hours }
  }

  private storeHours(storeId: string): Promise<StoreHours | null> {
    return this.prisma.client.businessHours.findUnique({
      where: { storeId },
      select: { timezone: true, schedule: true }
    })
  }

  // Quiet hours hold back push and sound, never the notification itself. Following the store means
  // quiet while the store is closed; a store with no hours, or hours that cannot be read, is never closed.
  async isInQuietHours(userId: string, storeId: string, at = new Date()): Promise<boolean> {
    const settings = await this.settingsOf(userId)
    if (!settings.quietHoursEnabled) return false
    const hours = settings.quietHoursFollowStore ? await this.storeHours(storeId) : null
    return isQuietAt(settings, hours, at)
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
    const types = body.types ?? []
    await this.prisma.transaction(async tx => {
      // One statement for all the types, not one upsert for each: a row that exists is changed, one that does not is made. The
      // pair (person, store) is the one of the request, never a column of the body
      if (types.length > 0) {
        await tx.$executeRaw`
          INSERT INTO notification_preferences (id, user_id, store_id, type, in_app, push, email, sound)
          SELECT gen_random_uuid()::text, ${userId}, ${storeId}, chosen.type, chosen.in_app, chosen.push, chosen.email, chosen.sound
            FROM unnest(
              ${types.map(row => row.type)}::text[],
              ${types.map(row => row.inApp)}::boolean[],
              ${types.map(row => row.push)}::boolean[],
              ${types.map(row => row.email)}::boolean[],
              ${types.map(row => row.sound)}::boolean[]
            ) AS chosen(type, in_app, push, email, sound)
            ORDER BY chosen.type
          ON CONFLICT (user_id, store_id, type) DO UPDATE
            SET in_app = EXCLUDED.in_app, push = EXCLUDED.push, email = EXCLUDED.email, sound = EXCLUDED.sound`
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
