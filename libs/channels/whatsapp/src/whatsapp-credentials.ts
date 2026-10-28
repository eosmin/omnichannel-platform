import { z } from 'zod'

import { ErrorCodes } from '@platform/core/errors'
import { PluginError } from '@platform/plugins/sdk'

// Ids of Meta are numbers written as text. They go into a url path, so nothing else is accepted.
const metaId = z.string().regex(/^\d{1,32}$/)

export const whatsAppCredentialsSchema = z.object({
  phoneNumberId: metaId,
  businessAccountId: metaId,
  // Sent as a header: printable ASCII only (the client refuses anything else)
  accessToken: z.string().min(1).max(1024)
})

export type WhatsAppCredentials = z.infer<typeof whatsAppCredentialsSchema>

// Credentials that do not have the shape are credentials that cannot work: the owner connects again.
// The zod error is not kept, it would name the field and could echo the value.
export function parseWhatsAppCredentials(input: unknown): WhatsAppCredentials {
  const parsed = whatsAppCredentialsSchema.safeParse(input)
  if (!parsed.success) {
    throw new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID, { retryable: false })
  }
  return parsed.data
}
