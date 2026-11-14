import { z } from 'zod'

import { ApiKeyLimits, isApiKeyScope, singleLineText, uuidSchema } from '@platform/core/domain'

export const idSchema = uuidSchema

const scopes = z
  .array(z.string().refine(isApiKeyScope, { message: 'is not a scope a key can hold' }))
  .min(1)
  .transform(values => [...new Set(values)])

export const createApiKeySchema = z.strictObject({
  name: singleLineText(ApiKeyLimits.NAME_MAX_LENGTH, 1),
  scopes,
  // Optional: a key without a date lasts until it is revoked. A date in the past makes a key that never worked.
  expiresAt: z.iso
    .datetime({ offset: true })
    .transform(value => new Date(value))
    .refine(date => date.getTime() > Date.now(), { message: 'must be in the future' })
    .optional()
})

export type CreateApiKeyBody = z.output<typeof createApiKeySchema>
