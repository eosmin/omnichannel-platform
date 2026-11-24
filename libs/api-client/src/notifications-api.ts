import { z } from 'zod'

import { ApiRoutes } from '@platform/core/api'
import { DigestFrequency } from '@platform/core/domain'
import type { NotificationFilter } from '@platform/core/notifications'

import type { ApiClient } from './api-client'

// A notification as the api tells it. `type`, `severity` and `messageKey` stay text: one a newer
// server sends and this page does not know must still draw (under a generic text), not break the list.
export const notificationSchema = z.object({
  id: z.string(),
  type: z.string(),
  severity: z.string(),
  messageKey: z.string(),
  params: z.record(z.string(), z.union([z.string(), z.number()])),
  resourceType: z.string().nullable(),
  resourceId: z.string().nullable(),
  actionPath: z.string().nullable(),
  readAt: z.string().nullable(),
  createdAt: z.string()
})
export type NotificationView = z.output<typeof notificationSchema>

export const notificationPageSchema = z.object({
  data: z.array(notificationSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean()
})
export type NotificationPageView = z.output<typeof notificationPageSchema>

// The notification center: the member's own notifications in this store, newest first
export function fetchNotifications(
  client: ApiClient,
  storeId: string,
  input: { filter: NotificationFilter; cursor: string | null },
  signal?: AbortSignal
): Promise<NotificationPageView> {
  const params = new URLSearchParams({ filter: input.filter })
  if (input.cursor !== null) params.set('cursor', input.cursor)
  return client.request(`${ApiRoutes.notifications.list}?${params.toString()}`, {
    schema: notificationPageSchema,
    storeId,
    signal
  })
}

const countSchema = z.object({ count: z.number().int().min(0) })

export async function fetchUnreadCount(
  client: ApiClient,
  storeId: string,
  signal?: AbortSignal
): Promise<number> {
  const { count } = await client.request(ApiRoutes.notifications.unreadCount, {
    schema: countSchema,
    storeId,
    signal
  })
  return count
}

const updatedSchema = z.object({ updated: z.number().int().min(0) })

export async function markNotificationsRead(
  client: ApiClient,
  storeId: string,
  ids: readonly string[]
): Promise<number> {
  const { updated } = await client.request(ApiRoutes.notifications.markRead, {
    method: 'POST',
    body: { ids },
    schema: updatedSchema,
    storeId
  })
  return updated
}

export async function markAllNotificationsRead(
  client: ApiClient,
  storeId: string
): Promise<number> {
  const { updated } = await client.request(ApiRoutes.notifications.markAllRead, {
    method: 'POST',
    schema: updatedSchema,
    storeId
  })
  return updated
}

// What the person chose (TDD_06 §9). `type` stays text: a type a newer server adds must not break the page.
export const typePreferenceSchema = z.object({
  type: z.string(),
  severity: z.string(),
  inApp: z.boolean(),
  push: z.boolean(),
  email: z.boolean(),
  sound: z.boolean()
})
export type TypePreferenceView = z.output<typeof typePreferenceSchema>

export const notificationSettingsSchema = z.object({
  quietHoursEnabled: z.boolean(),
  quietHoursStart: z.number().int().min(0).max(23),
  quietHoursEnd: z.number().int().min(0).max(23),
  quietHoursFollowStore: z.boolean(),
  timezone: z.string(),
  digestFrequency: z.enum(DigestFrequency),
  crossStoreEnabled: z.boolean(),
  crossStoreSupervisorOnly: z.boolean()
})
export type NotificationSettingsView = z.output<typeof notificationSettingsSchema>

export const notificationPreferencesSchema = z.object({
  types: z.array(typePreferenceSchema),
  settings: notificationSettingsSchema
})
export type NotificationPreferencesView = z.output<typeof notificationPreferencesSchema>

export interface NotificationPreferencesPatch {
  types?: { type: string; inApp: boolean; push: boolean; email: boolean; sound: boolean }[]
  settings?: Partial<NotificationSettingsView>
}

export function fetchNotificationPreferences(
  client: ApiClient,
  storeId: string,
  signal?: AbortSignal
): Promise<NotificationPreferencesView> {
  return client.request(ApiRoutes.notifications.preferences, {
    schema: notificationPreferencesSchema,
    storeId,
    signal
  })
}

// The per-type rows belong to the store of the header; the settings are the person's in every store
export function putNotificationPreferences(
  client: ApiClient,
  storeId: string,
  patch: NotificationPreferencesPatch
): Promise<NotificationPreferencesView> {
  return client.request(ApiRoutes.notifications.preferences, {
    method: 'PUT',
    body: patch,
    schema: notificationPreferencesSchema,
    storeId
  })
}
