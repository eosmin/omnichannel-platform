import { z } from 'zod'

import { MediaStatus } from '@platform/core/domain'
import { PresenceStatus } from '@platform/core/realtime'

// What the api answers, parsed at the edge: the browser never trusts a body it has not checked.
// The shapes mirror apps/api/src/modules/auth (AccountProfile, ConsumedMagicLink); a permission is
// kept as a string so that a server newer than the page cannot make the whole profile fail to parse.

export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    metadata: z.record(z.string(), z.unknown()).default({})
  }),
  correlationId: z.string()
})
export type ErrorBody = z.output<typeof errorResponseSchema>

export const accountMembershipSchema = z.object({
  storeId: z.string(),
  storeName: z.string(),
  role: z.string(),
  permissions: z.array(z.string())
})
export type AccountMembership = z.output<typeof accountMembershipSchema>

export const accountProfileSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  emailVerified: z.boolean(),
  locale: z.string(),
  timezone: z.string().nullable(),
  density: z.string(),
  memberships: z.array(accountMembershipSchema)
})
export type AccountProfile = z.output<typeof accountProfileSchema>

// What the Next server hands to the browser: the access token only. The refresh token stays in the
// httpOnly cookie that the server sets (TDD_01 §7).
export const accessSessionSchema = z.object({
  accessToken: z.string().min(1),
  expiresIn: z.number().int().positive()
})
export type AccessSession = z.output<typeof accessSessionSchema>

export const acceptedSchema = z.object({ accepted: z.literal(true) })

// The page of an invitation (GET /invitations/:token), public
export const invitationPreviewSchema = z.object({
  email: z.string(),
  storeName: z.string(),
  roleName: z.string(),
  inviterName: z.string(),
  expiresAt: z.string()
})
export type InvitationPreview = z.output<typeof invitationPreviewSchema>

// What the Next server answers to an accepted invitation: the store, and a session only when the
// accept created the account
export const acceptedInvitationSchema = z.object({
  store: z.object({ id: z.string(), name: z.string() }),
  role: z.string(),
  accessToken: z.string().min(1).optional(),
  expiresIn: z.number().int().positive().optional()
})
export type AcceptedInvitation = z.output<typeof acceptedInvitationSchema>

export const storeViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  timezone: z.string(),
  currency: z.string(),
  defaultLocale: z.string()
})
export type StoreView = z.output<typeof storeViewSchema>

// The reply a send answers with. Only what the client acts on: a server newer than the page may add
// fields, and the thread is read again through the REST api for the rest.
export const sentMessageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  deliveryStatus: z.string().nullable()
})
export type SentMessage = z.output<typeof sentMessageSchema>

// A status this page does not know is shown as offline instead of failing the whole list
export const userPresenceSchema = z.object({
  userId: z.string(),
  status: z.enum(PresenceStatus).catch(PresenceStatus.OFFLINE)
})
export const teamPresenceSchema = z.array(userPresenceSchema)
export type UserPresenceView = z.output<typeof userPresenceSchema>

// A row of the conversation list (GET /conversations). A status, channel, author or message type
// that this page does not know is kept as the text it came as: a server newer than the page must not
// break the whole list, and the row draws a neutral fallback for it.
export const conversationListItemSchema = z.object({
  id: z.string(),
  status: z.string(),
  channelType: z.string(),
  assignedTo: z.string().nullable(),
  unreadCount: z.number().int(),
  lastMessageAt: z.string().nullable(),
  snoozedUntil: z.string().nullable(),
  customer: z.object({
    id: z.string(),
    name: z.string().nullable(),
    displayIdentity: z.string(),
    username: z.string().nullable(),
    // A link a plugin chose: untrusted, drawn under the img-src of the CSP and replaced by the
    // initials when it fails
    avatarUrl: z.string().nullable()
  }),
  lastMessage: z
    .object({
      id: z.string(),
      authorType: z.string(),
      type: z.string(),
      contentPreview: z.string().nullable(),
      createdAt: z.string()
    })
    .nullable(),
  tags: z.array(z.object({ id: z.string(), name: z.string(), color: z.string() }))
})
export type ConversationListItemView = z.output<typeof conversationListItemSchema>

// GET /conversations/:id: the row of the list plus the account of the channel that serves it, which
// the templates of a plugin are asked for
export const conversationDetailSchema = conversationListItemSchema.extend({
  channelConnectionId: z.string()
})
export type ConversationDetailView = z.output<typeof conversationDetailSchema>

export const conversationPageSchema = z.object({
  data: z.array(conversationListItemSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean()
})
export type ConversationPageView = z.output<typeof conversationPageSchema>

// The numbers beside the filters (GET /conversations?countsOnly=true)
export const conversationCountsSchema = z.object({
  all: z.number().int(),
  mine: z.number().int(),
  unassigned: z.number().int(),
  byStatus: z.record(z.string(), z.number().int()),
  byChannel: z.record(z.string(), z.number().int()),
  byAgent: z.array(z.object({ userId: z.string(), count: z.number().int() })),
  // `byAgent` without the resolved ones (open or pending): the load of an agent
  activeByAgent: z.array(z.object({ userId: z.string(), count: z.number().int() }))
})
export type ConversationCountsView = z.output<typeof conversationCountsSchema>

// POST /conversations/bulk: each conversation is a change of its own, so the answer says which went
// through and which did not, with our code for the reason. `truncated` is true when a filter matched
// more conversations than BulkLimits.MAX_ITEMS allows.
export const bulkResultSchema = z.object({
  succeeded: z.array(z.string()),
  failed: z.array(z.object({ id: z.string(), code: z.string() })),
  truncated: z.boolean()
})
export type BulkResultView = z.output<typeof bulkResultSchema>

// GET /members: who the active members of the store are, for anyone who may see conversations
export const memberDirectoryEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  avatarMediaId: z.string().nullable(),
  role: z.object({ id: z.string(), name: z.string() })
})
export const memberDirectorySchema = z.array(memberDirectoryEntrySchema)
export type MemberDirectoryEntryView = z.output<typeof memberDirectoryEntrySchema>

// GET /settings/snippets: the saved replies of the store; readable by anyone who may see conversations
export const snippetSchema = z.object({
  id: z.string(),
  shortcut: z.string(),
  title: z.string(),
  content: z.string()
})
export const snippetListSchema = z.array(snippetSchema)
export type SnippetView = z.output<typeof snippetSchema>

// GET /settings/inbox/behavior: how resolving behaves in this store (TDD_09 §3.2) and the timezone its
// snooze presets are counted in, and the open count at which the team widget flags an agent
export const inboxBehaviorSchema = z.object({
  resolveShowOptions: z.boolean(),
  sendClosingMessage: z.boolean(),
  closingSnippetId: z.string().nullable(),
  agentLoadThreshold: z.number().int(),
  timezone: z.string()
})
export type InboxBehaviorView = z.output<typeof inboxBehaviorSchema>

// GET /channels/directory: the accounts of the store and what each channel can do, so that the
// inbox names a channel and draws only the actions it supports
export const channelDirectoryEntrySchema = z.object({
  id: z.string(),
  pluginId: z.string(),
  pluginName: z.string(),
  displayName: z.string(),
  status: z.string(),
  capabilities: z.array(z.string())
})
export const channelDirectorySchema = z.array(channelDirectoryEntrySchema)
export type ChannelDirectoryEntryView = z.output<typeof channelDirectoryEntrySchema>

// GET /conversations/:id/messages: the thread, newest first. Like the list, a type, author or status
// this page does not know is kept as the text it came as, and the bubble draws a neutral fallback.
const reactionSchema = z.object({
  emoji: z.string(),
  authorType: z.string(),
  authorId: z.string().nullable(),
  deliveryStatus: z.string(),
  deliveryError: z.string().nullable()
})

const quotedMessageSchema = z.object({
  id: z.string(),
  type: z.string(),
  authorType: z.string(),
  authorId: z.string().nullable(),
  content: z.string().nullable(),
  deleted: z.boolean()
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
  previousAssignee: z.string().nullable()
})

export const messageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  type: z.string(),
  content: z.string().nullable(),
  authorType: z.string(),
  authorId: z.string().nullable(),
  replyToMessageId: z.string().nullable(),
  replyTo: quotedMessageSchema.nullable(),
  deliveryStatus: z.string().nullable(),
  deliveryError: z.string().nullable(),
  system: systemLineSchema.nullable(),
  // Untrusted: drawn as a link with its host visible, never fetched
  attachmentUrl: z.string().nullable(),
  reactions: z.array(reactionSchema),
  // Never a link: the signed one is asked from `GET /media/:id` once the file is clean
  media: z.array(
    z.object({
      id: z.string(),
      filename: z.string(),
      contentType: z.string(),
      fileSize: z.number(),
      // A status of a newer server is a file still being processed, not a thread that fails to draw
      status: z.enum(MediaStatus).catch(MediaStatus.PENDING)
    })
  ),
  // Files of the customer the platform could not keep; a code of a newer server is drawn as a generic one
  unavailableFiles: z.array(z.object({ index: z.number().int(), code: z.string() })),
  // The file of a reply went and the text under it did not
  captionFailed: z.boolean(),
  // The ids of the teammates a note mentions; `version` is the one an edit of a note must carry
  mentions: z.array(z.string()),
  version: z.number().int(),
  editedAt: z.string().nullable(),
  editedByType: z.string().nullable(),
  editedById: z.string().nullable(),
  pendingEdit: z.boolean(),
  editStatus: z.string().nullable(),
  editError: z.string().nullable(),
  deletedAt: z.string().nullable(),
  deletedByType: z.string().nullable(),
  deletedById: z.string().nullable(),
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

// GET /conversations/:id/origins: where the conversation came from, newest first. The links came from
// an ad or a post: untrusted, never drawn; the card draws the files the worker kept.
// A picture of the ad kept as a file of the store: `pending` until the scan ends, then `clean`
// An api that does not send the field yet (a rolling deploy) is a card with no picture, not a failed list
const originFileSchema = z
  .object({ id: z.string(), status: z.string() })
  .nullish()
  .transform(file => file ?? null)
export const conversationOriginSchema = z.object({
  id: z.string(),
  messageId: z.string(),
  kind: z.string(),
  sourceId: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  title: z.string().nullable(),
  body: z.string().nullable(),
  mediaType: z.string().nullable(),
  mediaUrl: z.string().nullable(),
  thumbnailUrl: z.string().nullable(),
  mediaFile: originFileSchema,
  thumbnailFile: originFileSchema,
  createdAt: z.string()
})
export const conversationOriginListSchema = z.array(conversationOriginSchema)
export type ConversationOriginView = z.output<typeof conversationOriginSchema>

// GET /conversations/:id/messaging-window: whether free text may go to the customer now. `closesAt` is
// null when the channel has no window, or when the customer never wrote.
export const messagingWindowSchema = z.object({
  open: z.boolean(),
  closesAt: z.string().nullable(),
  requiresTemplate: z.boolean()
})
export type MessagingWindowView = z.output<typeof messagingWindowSchema>

// GET /channels/:pluginId/templates: a status this page does not know is kept as the text it came as
// and is not selectable
export const channelTemplateSchema = z.object({
  name: z.string(),
  language: z.string(),
  status: z.string(),
  body: z.string()
})
export const channelTemplateListSchema = z.array(channelTemplateSchema)
export type ChannelTemplateView = z.output<typeof channelTemplateSchema>

// GET /messages/:id/deleted-content: the kept text of a message the customer deleted
export const deletedContentSchema = z.object({ content: z.string().nullable() })
export type DeletedContentView = z.output<typeof deletedContentSchema>

// GET /messages/:id/revisions: the earlier texts of an edited message, as the api orders them
export const revisionSchema = z.object({
  version: z.number().int(),
  content: z.string().nullable(),
  editedByType: z.string(),
  editedById: z.string().nullable(),
  createdAt: z.string()
})
export const revisionListSchema = z.array(revisionSchema)
export type RevisionView = z.output<typeof revisionSchema>

// GET /settings/tags: the tags of the store, for the filter of the inbox
export const tagSchema = z.object({ id: z.string(), name: z.string(), color: z.string() })
export const tagListSchema = z.array(tagSchema)
export type TagView = z.output<typeof tagSchema>

// GET /customers/:id: what the profile shows. The dates come as text.
export const customerDetailSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  locale: z.string().nullable(),
  isCaution: z.boolean(),
  cautionReason: z.string().nullable(),
  identities: z.array(
    z.object({
      id: z.string(),
      channelType: z.string(),
      channelIdentity: z.string(),
      displayName: z.string().nullable(),
      lastInboundAt: z.string().nullable()
    })
  ),
  addresses: z.array(
    z.object({
      id: z.string(),
      label: z.string().nullable(),
      line1: z.string(),
      line2: z.string().nullable(),
      city: z.string(),
      state: z.string().nullable(),
      postalCode: z.string().nullable(),
      country: z.string(),
      isDefault: z.boolean()
    })
  ),
  tags: z.array(z.object({ id: z.string(), name: z.string(), color: z.string() })),
  createdAt: z.string(),
  updatedAt: z.string()
})
export type CustomerDetailView = z.output<typeof customerDetailSchema>

export type CustomerAddressView = CustomerDetailView['addresses'][number]
export const customerAddressSchema = customerDetailSchema.shape.addresses.element

// GET /customers: a row of the customers page
export const customerListItemSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  isCaution: z.boolean(),
  channels: z.array(z.string()),
  tags: z.array(z.object({ id: z.string(), name: z.string(), color: z.string() })),
  createdAt: z.string()
})
export type CustomerListItemView = z.output<typeof customerListItemSchema>
export const customerListPageSchema = z.object({
  data: z.array(customerListItemSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean()
})
export type CustomerListPageView = z.output<typeof customerListPageSchema>

// POST /customers/:id/notes
export const customerNoteSchema = z.object({
  id: z.string(),
  authorId: z.string(),
  content: z.string(),
  createdAt: z.string()
})
export type CustomerNoteView = z.output<typeof customerNoteSchema>

// GET /customers/:id/merge-preview?absorbedId= (TDD_09 §6.1): both sides, the counts and the contact
// fields where the two hold a different value
const mergeSideSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  channels: z.array(z.string())
})
const mergeCountSchema = z.object({
  survivor: z.number(),
  absorbed: z.number(),
  merged: z.number()
})
export const customerMergePreviewSchema = z.object({
  survivor: mergeSideSchema,
  absorbed: mergeSideSchema,
  counts: z.object({
    conversations: mergeCountSchema,
    notes: mergeCountSchema,
    addresses: mergeCountSchema,
    tags: mergeCountSchema,
    identities: mergeCountSchema
  }),
  // A field this page does not know is dropped: the dialog can only draw the ones it has a label for
  conflicts: z.array(z.string())
})
export type CustomerMergePreviewView = z.output<typeof customerMergePreviewSchema>

// POST /customers/:id/identities
export const customerIdentitySchema = customerDetailSchema.shape.identities.element
export type CustomerIdentityView = z.output<typeof customerIdentitySchema>

// POST /customers/:id/tags answers the tags the customer now holds
export const customerTagListSchema = customerDetailSchema.shape.tags

// The three kinds of entry of GET /customers/:id/timeline (orders join in Step 4.3)
const timelineConversationSchema = z.object({
  type: z.literal('conversation'),
  id: z.string(),
  at: z.string(),
  channelType: z.string(),
  status: z.string()
})
const timelineNoteSchema = z.object({
  type: z.literal('note'),
  id: z.string(),
  at: z.string(),
  authorId: z.string(),
  authorName: z.string().nullable(),
  content: z.string()
})
const timelineMergeSchema = z.object({
  type: z.literal('merge'),
  id: z.string(),
  at: z.string(),
  absorbedId: z.string(),
  mergedById: z.string(),
  mergedByName: z.string().nullable(),
  unmergeUntil: z.string(),
  unmergedAt: z.string().nullable()
})
export const customerTimelineEntrySchema = z.discriminatedUnion('type', [
  timelineConversationSchema,
  timelineNoteSchema,
  timelineMergeSchema
])
export type CustomerTimelineEntryView = z.output<typeof customerTimelineEntrySchema>

// An entry of a kind this page does not know (a server newer than the page) is left out: it must not
// break the whole timeline
export const customerTimelinePageSchema = z.object({
  data: z.array(z.unknown()).transform(entries =>
    entries.flatMap(entry => {
      const parsed = customerTimelineEntrySchema.safeParse(entry)
      return parsed.success ? [parsed.data] : []
    })
  ),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean()
})
export type CustomerTimelinePageView = z.output<typeof customerTimelinePageSchema>
