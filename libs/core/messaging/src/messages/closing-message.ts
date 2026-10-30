import { z } from 'zod'

// The `metadata` of the message that closes a resolution (the saved reply of the resolve dialog). The
// worker sends it only while the conversation is still resolved by that resolution, so it has to know
// which message it is: the job may be the sweep's, which carries nothing but ids.
export const closingMessageMetadataSchema = z.object({ closing: z.literal(true) })

export const CLOSING_MESSAGE_METADATA: z.output<typeof closingMessageMetadataSchema> = {
  closing: true
}

export function isClosingMessage(metadata: unknown): boolean {
  return closingMessageMetadataSchema.safeParse(metadata).success
}
