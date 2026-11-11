import { z } from 'zod'

import {
  CaptionState,
  ChannelDescriptorLimits,
  ContactCardLimits,
  DEFAULT_CHANNEL_ICON_KEY,
  isChannelIconKey,
  isChannelManagementSurface,
  isDialogOrigin,
  isPlainDescriptorText,
  LINKED_ACCOUNT_PLACEHOLDERS,
  MediaStatus,
  MessageType,
  parseAssetIdPattern
} from '@platform/core/domain'
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
  memberships: z.array(accountMembershipSchema),
  // Stores the person belongs to and may not enter for now (an older api sends none)
  suspendedStores: z.array(z.object({ storeId: z.string(), storeName: z.string() })).default([])
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

// The organization of the store in X-Store-Id (GET /organizations/current)
export const organizationViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string()
})
export type OrganizationView = z.output<typeof organizationViewSchema>

// The person's own name and picture (GET /account/profile). `avatarUrl` is a short-lived signed link,
// null while the picture is scanned, when it was refused and when there is none.
export const ownProfileSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  avatarMediaId: z.string().nullable(),
  avatarUrl: z.string().nullable()
})
export type OwnProfile = z.output<typeof ownProfileSchema>

// Locale, timezone and density are kept as the text they came as: a server newer than the page must
// not make the whole page fail
export const accountPreferencesSchema = z.object({
  locale: z.string(),
  timezone: z.string().nullable(),
  density: z.string()
})
export type AccountPreferences = z.output<typeof accountPreferencesSchema>

// A signed-in device (GET /auth/sessions); `id` is the family, which survives the rotation of the token
export const activeSessionSchema = z.object({
  id: z.string(),
  userAgent: z.string().nullable(),
  ipAddress: z.string().nullable(),
  lastActiveAt: z.string(),
  current: z.boolean()
})
export type ActiveSession = z.output<typeof activeSessionSchema>

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
  // Declared by the plugin of the channel: nobody gives these customers a name (a visitor of a site)
  anonymousCustomers: z.boolean().catch(false),
  assignedTo: z.string().nullable(),
  unreadCount: z.number().int(),
  lastMessageAt: z.string().nullable(),
  snoozedUntil: z.string().nullable(),
  // A mark that raised the row until someone opens it. `reason` is kept as the text it came as (a
  // newer server may have more of them); `note` is text of an agent, drawn escaped.
  attention: z
    .object({ reason: z.string(), at: z.string(), note: z.string().nullable() })
    .nullable(),
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
// more conversations than BulkLimits.MAX_ITEMS allows. `exported` comes only with "Export CSV" of a whole
// filter: the file has no cap and no ids, and this is how many conversations it will hold.
export const bulkResultSchema = z.object({
  succeeded: z.array(z.string()),
  failed: z.array(z.object({ id: z.string(), code: z.string() })),
  truncated: z.boolean(),
  exported: z.number().int().optional()
})
export type BulkResultView = z.output<typeof bulkResultSchema>

// GET /members: who the active members of the store are, for anyone who may see conversations
export const memberDirectoryEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  avatarMediaId: z.string().nullable(),
  role: z.object({ id: z.string(), name: z.string() }),
  // Whether their role can be given a conversation (it can open it and answer it)
  // A server older than the page does not send it: the page then offers everyone, and the server
  // still refuses whoever cannot be given a conversation
  canBeAssigned: z.boolean().default(true)
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

// How a channel is named and drawn, as its plugin declared it. A third party wrote it, so the browser checks it
// again before it draws anything: a text that is not plain, an icon outside the closed set, a surface that does
// not exist, each falls back to something safe. A name or a help text that is not plain is not repaired: the
// descriptor is then none (null) for that channel, and the interface draws it as a channel with no descriptor. It
// never makes the whole list fail.
const plainText = z.string().refine(value => isPlainDescriptorText(value))
export const localizedTextSchema = z.object({ es: plainText, en: plainText })
export const channelDescriptorSchema = z.object({
  displayName: localizedTextSchema,
  iconKey: z
    .string()
    .transform(value => (isChannelIconKey(value) ? value : DEFAULT_CHANNEL_ICON_KEY))
    .catch(DEFAULT_CHANNEL_ICON_KEY),
  anonymousCustomers: z.boolean().catch(false),
  managementSurface: z
    .string()
    .nullable()
    .transform(value => (isChannelManagementSurface(value) ? value : null))
    .catch(null),
  helpSteps: z
    .array(
      z.object({
        es: z
          .string()
          .refine(value => isPlainDescriptorText(value, ChannelDescriptorLimits.HELP_MAX_LENGTH)),
        en: z
          .string()
          .refine(value => isPlainDescriptorText(value, ChannelDescriptorLimits.HELP_MAX_LENGTH))
      })
    )
    .max(ChannelDescriptorLimits.MAX_HELP_STEPS)
    .catch([])
})
export type ChannelDescriptorView = z.output<typeof channelDescriptorSchema>

// How the login of a channel is drawn. The browser checks it again: the address the button sends a person to is
// an origin the provider's site is reached at and nothing else, and a descriptor that is not valid is none (the
// channel then has no "connect with" button), never a failure of the list.
const linkedAccountSchema = z.object({
  required: z.boolean(),
  label: z.object({
    es: z
      .string()
      .refine(value => isPlainDescriptorText(value, undefined, LINKED_ACCOUNT_PLACEHOLDERS)),
    en: z
      .string()
      .refine(value => isPlainDescriptorText(value, undefined, LINKED_ACCOUNT_PLACEHOLDERS))
  }),
  missingLabel: localizedTextSchema
})
export const channelOAuthDescriptorSchema = z.object({
  dialogOrigin: z.string().refine(value => isDialogOrigin(value)),
  providerName: localizedTextSchema,
  linkedAccount: linkedAccountSchema.nullable(),
  assetIdPattern: z.string().refine(value => parseAssetIdPattern(value) !== null)
})
export type ChannelOAuthDescriptorView = z.output<typeof channelOAuthDescriptorSchema>

// GET /channels/directory: the accounts of the store and what each channel can do, so that the
// inbox names a channel and draws only the actions it supports
export const channelDirectoryEntrySchema = z.object({
  id: z.string(),
  pluginId: z.string(),
  pluginName: z.string(),
  displayName: z.string(),
  status: z.string(),
  capabilities: z.array(z.string()),
  // What the channel takes in one message of each kind of file it declares: a kind that is not here is a
  // file the channel does not take. Absent from a server that does not say it (the check is then the api's).
  media: z
    .array(
      z.object({
        type: z.string(),
        maxFiles: z.number().int().min(1),
        types: z.array(z.string()).nullable(),
        maxBytes: z.number().int().min(1),
        // Whether a text goes under EACH file of a message (the composer offers one per file) or only
        // under the first. Absent from a server that does not say it: only the first.
        captionsPerFile: z.boolean().optional().default(false)
      })
    )
    .optional(),
  // The longest text of a message on the channel, and the caption rule when it has one of its own. Absent
  // from a server that does not say it, and null for a channel whose plugin is gone.
  limits: z
    .object({
      textMaxLength: z.number().int().min(1),
      caption: z
        .object({
          maxLength: z.number().int().min(1),
          withoutCaption: z.array(z.enum(MessageType))
        })
        .nullable()
    })
    .nullable()
    .optional(),
  // How the channel is named and drawn. Absent from a server that does not say it, and none for a channel
  // whose plugin is gone or whose descriptor is not valid.
  descriptor: channelDescriptorSchema.nullable().optional().catch(null)
})
export const channelDirectorySchema = z.array(channelDirectoryEntrySchema)
export type ChannelDirectoryEntryView = z.output<typeof channelDirectoryEntrySchema>

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
      filename: z.string(),
      contentType: z.string(),
      fileSize: z.number(),
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
  // The phone without its country code, for the recipient phones of an order
  nationalPhone: z.string().nullable().default(null),
  locale: z.string().nullable(),
  isCaution: z.boolean(),
  cautionReason: z.string().nullable(),
  identities: z.array(
    z.object({
      id: z.string(),
      channelType: z.string(),
      channelIdentity: z.string(),
      displayName: z.string().nullable(),
      lastInboundAt: z.string().nullable(),
      // As on a conversation: declared by the plugin of the channel of the identity
      anonymousCustomers: z.boolean().catch(false)
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

// POST /customers: the customer that was saved and, apart, the customers of the store that share its e-mail or phone
// (a hint: the customer exists whatever it looks like; empty when the caller may not see customers)
export const createdCustomerSchema = customerDetailSchema.extend({
  possibleDuplicates: z
    .array(
      z.object({
        id: z.string(),
        name: z.string().nullable(),
        email: z.string().nullable(),
        phone: z.string().nullable(),
        // Which of the contact data matched (a value of DuplicateMatch)
        matchedOn: z.array(z.string())
      })
    )
    .default([])
})
export type CreatedCustomerView = z.output<typeof createdCustomerSchema>

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
