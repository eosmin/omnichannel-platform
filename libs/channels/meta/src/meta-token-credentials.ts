import { z } from 'zod'

import { ErrorCodes } from '@platform/core/errors'
import { PluginError } from '@platform/plugins/sdk'

// Instagram and Messenger connect with one token: it names the account it belongs to, so the id is
// read from Meta at connect and never pasted next to it (a pasted id could disagree with the token).
// Sent as a header: printable ASCII only (the client refuses anything else).
export const metaTokenCredentialsSchema = z.object({
  accessToken: z.string().min(1).max(1024)
})

export type MetaTokenCredentials = z.infer<typeof metaTokenCredentialsSchema>

// Credentials that do not have the shape cannot work: the owner connects again. The zod error is not
// kept, it would name the field and could echo the value.
export function parseMetaTokenCredentials(input: unknown): MetaTokenCredentials {
  const parsed = metaTokenCredentialsSchema.safeParse(input)
  if (!parsed.success) {
    throw new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID, { retryable: false })
  }
  return parsed.data
}
