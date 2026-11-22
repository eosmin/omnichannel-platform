import { z } from 'zod'

import {
  REMOTE_CONNECTION_ID_PATTERN,
  RemoteChannelApiLimits,
  singleLineText
} from '@platform/core/domain'

// `:connectionId` of the routes: the plugin's own identifier of the account (TDD_10 §6.7.5)
export const connectionIdParamSchema = z
  .string()
  .min(1)
  .max(RemoteChannelApiLimits.CONNECTION_ID_MAX_LENGTH)
  .regex(REMOTE_CONNECTION_ID_PATTERN)

// What a plugin says about the account: its name and a little data about it. The credentials of the account stay in the plugin
// and have no place here: a field that is not listed is refused.
export const putConnectionSchema = z.strictObject({
  displayName: singleLineText(RemoteChannelApiLimits.DISPLAY_NAME_MAX_LENGTH, 1),
  metadata: z
    .record(z.string(), z.json())
    .refine(
      value =>
        Buffer.byteLength(JSON.stringify(value)) <=
        RemoteChannelApiLimits.CONNECTION_METADATA_MAX_BYTES,
      { message: 'metadata is too large' }
    )
    .optional()
})

export type PutConnectionBody = z.output<typeof putConnectionSchema>
