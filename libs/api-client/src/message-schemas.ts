import { z } from 'zod'

import {
  CaptionState,
  ContactCardLimits,
  OrderLineLimits,
  MediaStatus
} from '@platform/core/domain'

// GET /conversations/:id/messages: the thread, newest first. Like the list, a type, author or status
// this page does not know is kept as the text it came as, and the bubble draws a neutral fallback.
const reactionSchema = z.object({
  emoji: z.string(),
  authorType: z.string(),
  authorId: z.string().nullable(),
  // The file of an album the reaction is under; null: the message (a server that does not send it yet)
  mediaId: z.string().nullable().default(null),
  // The file to draw it under, already resolved by the server; null: the message's
  fileId: z.string().nullable().default(null),
  deliveryStatus: z.string(),
  deliveryError: z.string().nullable()
})

const quotedMessageSchema = z.object({
  id: z.string(),
  type: z.string(),
  authorType: z.string(),
  authorId: z.string().nullable(),
  content: z.string().nullable(),
  deleted: z.boolean(),
  // The file of an album that was quoted, and where it is in the message (its place, else its order from 0); null: the
  // message as a whole, and a server that does not send it yet
  file: z
    .object({ mediaId: z.string(), position: z.number().int() })
    .nullable()
    .catch(null)
    .default(null)
})

// A system line has no text: the page writes it from the event, the people and the dates
const systemLineSchema = z.object({
  event: z.string(),
  actor: z.object({ type: z.string(), id: z.string().nullable() }),
  causedBy: z.string().nullable(),
  from: z.string().nullable(),
  to: z.string().nullable(),
  reason: z.string().nullable(),
  snoozedUntil: z.string().nullable(),
  assignedTo: z.string().nullable(),
  previousAssignee: z.string().nullable(),
  // The reminder left when snoozing, on the line of waking; absent on lines of before it existed
  note: z.string().nullable().optional()
})

export const messageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  type: z.string(),
  content: z.string().nullable(),
  authorType: z.string(),
  authorId: z.string().nullable(),
  // The plugin that wrote the message and the name it chose to write as the system (Step 5.6): null when no plugin wrote it;
  // optional so that an answer from before they existed still parses. The thread draws them (Step 5.6 W2).
  authorPluginId: z.string().nullable().optional(),
  authorNickname: z.string().nullable().optional(),
  replyToMessageId: z.string().nullable(),
  // The file of an album that the reply quotes; null: the message (a server that does not send it yet)
  replyToMediaId: z.string().nullable().default(null),
  replyTo: quotedMessageSchema.nullable(),
  deliveryStatus: z.string().nullable(),
  deliveryError: z.string().nullable(),
  // True when a failed reply is known not to have gone (it can be sent again or discarded); optional so that an
  // answer from before it existed still parses
  failureDefinitive: z.boolean().nullable().optional(),
  system: systemLineSchema.nullable(),
  location: z
    .object({
      latitude: z.number(),
      longitude: z.number(),
      name: z.string().nullable(),
      address: z.string().nullable()
    })
    .nullable()
    // A server that does not send it yet (a rolling deploy) draws no card instead of failing the thread
    .default(null),
  // The cards of a shared contact; a server that does not send it yet (a rolling deploy) draws the line of a
  // type this page cannot show, as before
  // Bounded again here: the page draws what the answer holds, and one that does not fit the limits of the
  // server (a stale deploy, a cache) is drawn as the line of a type this page cannot show, not as a huge card
  contacts: z
    .array(
      z.object({
        name: z.string().max(ContactCardLimits.NAME_MAX_LENGTH),
        phones: z
          .array(
            z.object({
              number: z.string().max(ContactCardLimits.PHONE_MAX_LENGTH),
              kind: z.string().max(ContactCardLimits.KIND_MAX_LENGTH).optional()
            })
          )
          .max(ContactCardLimits.MAX_PHONES),
        emails: z
          .array(
            z.object({
              address: z.string().max(ContactCardLimits.EMAIL_MAX_LENGTH),
              kind: z.string().max(ContactCardLimits.KIND_MAX_LENGTH).optional()
            })
          )
          .max(ContactCardLimits.MAX_EMAILS)
      })
    )
    .max(ContactCardLimits.MAX_CONTACTS)
    .nullable()
    .catch(null)
    .default(null),
  // The line of an order in the thread: a pointer to the order and the figures the card shows, never a note, an address
  // or a phone. Bounded here as the server bounds it; a line that does not fit is drawn as a plain order line of the
  // type, with no card, and a server that does not send it yet (a rolling deploy) sends none.
  orderSummary: z
    .object({
      event: z.string().max(OrderLineLimits.EVENT_MAX_LENGTH),
      orderId: z.uuid(),
      orderNumber: z.string().min(1).max(OrderLineLimits.NUMBER_MAX_LENGTH),
      status: z.string().max(OrderLineLimits.STATUS_MAX_LENGTH),
      previousStatus: z.string().max(OrderLineLimits.STATUS_MAX_LENGTH).nullable(),
      totalCents: z.number().int().nonnegative(),
      currency: z.string().length(3),
      itemCount: z.number().int().nonnegative()
    })
    .nullable()
    .catch(null)
    .default(null),
  // A server that does not send it yet (a rolling deploy) draws the image in its bubble, as before
  sticker: z.boolean().default(false),
  // Untrusted: drawn as a link with its host visible, never fetched
  attachmentUrl: z.string().nullable(),
  // The story of the business that the message answers (untrusted link, expires within about a day, may be
  // null); a server that does not send it yet (a rolling deploy) draws the message as a plain one
  storyReply: z
    .object({
      // Only https is drawn, whatever a server sends: `data:` and `blob:` are allowed by the CSP
      url: z
        .string()
        .nullable()
        .transform(url => (url !== null && url.startsWith('https://') ? url : null))
    })
    .nullable()
    .default(null),
  // The type a channel could not read, when the text is only its English `[type]` marker; a server that
  // does not send it yet (a rolling deploy) draws the text as before
  unsupportedType: z.string().nullable().default(null),
  reactions: z.array(reactionSchema),
  // Never a link: the signed one is asked from `GET /media/:id` once the file is clean
  media: z.array(
    z.object({
      id: z.string(),
      // Null for a reader who may not see files (`media:view`): the server takes the name, the type and the size out (BAN-R-meta)
      filename: z.string().nullable(),
      contentType: z.string().nullable(),
      fileSize: z.number().nullable(),
      // A status of a newer server is a file still being processed, not a thread that fails to draw
      status: z.enum(MediaStatus).catch(MediaStatus.PENDING),
      // Of a reply with several files: the place of the file in the message and how it stands (`queued`,
      // `sent`, `delivered`, `read`, `failed`) with our code when it failed. Null for a customer's file and
      // for a server that does not send them yet; a state of a newer server is read as none.
      position: z.number().int().nullable().catch(null).default(null),
      delivery: z.string().nullable().catch(null).default(null),
      errorCode: z.string().nullable().catch(null).default(null),
      // The text under this file (text of an agent: drawn escaped). How the text of the message went is on the
      // message (`captionState`). Null for a server that does not send it yet.
      caption: z.string().nullable().catch(null).default(null),
      // The provider has an id of its own for this file, so a reaction or a quote can name it alone (false in a
      // a file with no id yet or whose id another file shares; a server that does not send it: false)
      targetable: z.boolean().catch(false).default(false)
    })
  ),
  // Files of the customer the platform could not keep; a code of a newer server is drawn as a generic one
  unavailableFiles: z.array(
    z.object({ index: z.number().int(), code: z.string(), canRetry: z.boolean() })
  ),
  // The text under a file that went apart from it: failed, unconfirmed (the provider may have delivered
  // it) or queued (an agent asked to send it again); null otherwise, and for a state of a newer server
  captionState: z
    .enum([CaptionState.FAILED, CaptionState.UNCONFIRMED, CaptionState.QUEUED])
    .nullable()
    .catch(null),
  // The text of the message is a message of its own after the files, not the text under the first one (then
  // every file has its own text, the first included); false for a server that does not send it yet
  textApart: z.boolean().catch(false),
  // The ids of the teammates a note mentions; `version` is the one an edit of a note must carry
  mentions: z.array(z.string()),
  version: z.number().int(),
  editedAt: z.string().nullable(),
  editedByType: z.string().nullable(),
  editedById: z.string().nullable(),
  // The plugin that edited or deleted it (Step 5.6 W2): null when a person or the channel did; optional so that an answer
  // from before they existed still parses
  editedByPluginId: z.string().nullable().optional(),
  pendingEdit: z.boolean(),
  editStatus: z.string().nullable(),
  editError: z.string().nullable(),
  deletedAt: z.string().nullable(),
  deletedByType: z.string().nullable(),
  deletedById: z.string().nullable(),
  deletedByPluginId: z.string().nullable().optional(),
  deleteStatus: z.string().nullable(),
  deleteError: z.string().nullable(),
  createdAt: z.string()
})
export type MessageView = z.output<typeof messageSchema>
export type ReactionView = z.output<typeof reactionSchema>

export const messagePageSchema = z.object({
  data: z.array(messageSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean()
})
export type MessagePageView = z.output<typeof messagePageSchema>
