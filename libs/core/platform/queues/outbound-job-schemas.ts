import { z } from 'zod'

import { exactly } from './exact-schema'
import type {
  SendOutboundCaptionJob,
  SendOutboundDeleteJob,
  SendOutboundEditJob,
  SendOutboundMessageJob,
  SendOutboundReactionJob,
  SendOutboundReadReceiptJob,
  SendOutboundTypingJob
} from './job-types'

const correlationId = z.string().optional()

export const outboundMessageJobSchema = exactly<SendOutboundMessageJob>()(
  z.object({ storeId: z.uuid(), messageId: z.uuid(), correlationId })
)
// An edit, a deletion or a caption sent again: the `version` of the message when the agent asked. One
// schema for each kind, so that each is tied at compile time to the keys of its own job type (they
// are the same at runtime: the kind of a job is told by its name).
const changeShape = {
  storeId: z.uuid(),
  messageId: z.uuid(),
  version: z.number().int(),
  correlationId
}
export const outboundEditJobSchema = exactly<SendOutboundEditJob>()(z.object(changeShape))
export const outboundDeleteJobSchema = exactly<SendOutboundDeleteJob>()(z.object(changeShape))
export const outboundCaptionJobSchema = exactly<SendOutboundCaptionJob>()(z.object(changeShape))
export const outboundReactionJobSchema = exactly<SendOutboundReactionJob>()(
  z.object({
    storeId: z.uuid(),
    messageId: z.uuid(),
    userId: z.uuid(),
    version: z.number().int(),
    // The file of an album the reaction is under; absent: the message itself
    // As permissive as the id the web widget may choose for a file (`CHOSEN_ID` of the media fetcher): a
    // strict uuid would refuse a reaction under a file whose stored id is not an RFC one
    mediaId: z.guid().optional(),
    correlationId
  })
)
export const outboundReadReceiptJobSchema = exactly<SendOutboundReadReceiptJob>()(
  z.object({ storeId: z.uuid(), conversationId: z.uuid(), messageId: z.uuid(), correlationId })
)
export const outboundTypingJobSchema = exactly<SendOutboundTypingJob>()(
  z.object({
    storeId: z.uuid(),
    conversationId: z.uuid(),
    active: z.boolean(),
    at: z.number().int(),
    correlationId
  })
)
