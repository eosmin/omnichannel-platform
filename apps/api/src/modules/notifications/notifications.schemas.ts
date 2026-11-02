import { z } from 'zod'

import {
  DigestFrequency,
  PaginationLimits,
  timezoneSchema,
  uuidSchema
} from '@platform/core/domain'
import {
  isBase64UrlOfBytes,
  isPushEndpoint,
  normalizePushEndpoint,
  NotificationFilters,
  NotificationLimits,
  NotificationTypes,
  PushLimits
} from '@platform/core/notifications'

import { cursorSchema } from '../customers/list-cursor'

export const listNotificationsQuerySchema = z.strictObject({
  cursor: cursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(PaginationLimits.MAX).default(PaginationLimits.DEFAULT),
  filter: z.enum(NotificationFilters).default(NotificationFilters.ALL)
})
export type ListNotificationsQuery = z.output<typeof listNotificationsQuerySchema>

export const markReadBodySchema = z.strictObject({
  ids: z.array(uuidSchema).min(1).max(NotificationLimits.MARK_READ_MAX_IDS)
})
export type MarkReadBody = z.output<typeof markReadBodySchema>

const hourSchema = z.number().int().min(0).max(23)

const typePreferenceSchema = z.strictObject({
  type: z.enum(NotificationTypes),
  inApp: z.boolean(),
  push: z.boolean(),
  email: z.boolean(),
  sound: z.boolean()
})

const settingsPatchSchema = z.strictObject({
  quietHoursEnabled: z.boolean(),
  quietHoursStart: hourSchema,
  quietHoursEnd: hourSchema,
  quietHoursFollowStore: z.boolean(),
  timezone: timezoneSchema,
  digestFrequency: z.enum(DigestFrequency),
  crossStoreEnabled: z.boolean(),
  crossStoreSupervisorOnly: z.boolean()
})

// The per-type toggles belong to the store of the header; the settings are the user's, whatever store
export const putPreferencesBodySchema = z
  .strictObject({
    types: z
      .array(typePreferenceSchema)
      .max(Object.keys(NotificationTypes).length)
      .refine(rows => new Set(rows.map(row => row.type)).size === rows.length, {
        message: 'a type is listed twice'
      })
      .optional(),
    settings: settingsPatchSchema.partial().optional()
  })
  .refine(body => (body.types?.length ?? 0) > 0 || Object.keys(body.settings ?? {}).length > 0, {
    message: 'nothing to change'
  })
export type PutPreferencesBody = z.output<typeof putPreferencesBodySchema>

// What a browser gives after pushManager.subscribe (TDD_06 §7.3). The endpoint is a url the worker
// will call, so only the hosts of the push services pass (PushServiceHosts).
export const pushSubscriptionBodySchema = z.strictObject({
  endpoint: z
    .string()
    .refine(isPushEndpoint, 'must be the endpoint of a push service')
    .transform(normalizePushEndpoint),
  p256dh: z
    .string()
    .max(PushLimits.MAX_KEY_LENGTH)
    .refine(value => isBase64UrlOfBytes(value, PushLimits.P256DH_BYTES), 'must be the p256dh key'),
  auth: z
    .string()
    .max(PushLimits.MAX_KEY_LENGTH)
    .refine(value => isBase64UrlOfBytes(value, PushLimits.AUTH_BYTES), 'must be the auth secret'),
  userAgent: z.string().max(PushLimits.MAX_USER_AGENT_LENGTH).optional()
})
export type PushSubscriptionBody = z.output<typeof pushSubscriptionBodySchema>

export const removePushSubscriptionBodySchema = z.strictObject({
  endpoint: z.string().min(1).max(PushLimits.MAX_ENDPOINT_LENGTH)
})
export type RemovePushSubscriptionBody = z.output<typeof removePushSubscriptionBodySchema>
