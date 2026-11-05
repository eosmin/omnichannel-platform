// What the three Meta channels (WhatsApp, Instagram, Messenger) share: one app, one webhook
// signature, one Graph API.
export const MetaWebhook = {
  SIGNATURE_HEADER: 'x-hub-signature-256',
  SIGNATURE_PREFIX: 'sha256=',
  MODE_PARAM: 'hub.mode',
  VERIFY_TOKEN_PARAM: 'hub.verify_token',
  CHALLENGE_PARAM: 'hub.challenge',
  SUBSCRIBE_MODE: 'subscribe'
} as const

// The form of a file upload to the Graph API
export const MetaUpload = {
  FILE_FIELD: 'file',
  // The name sent with the bytes is fixed: the real name of a document travels in the message
  FILE_NAME: 'upload',
  BOUNDARY_PREFIX: '----platform',
  FORM_CONTENT_TYPE: 'multipart/form-data'
} as const

// The Meta app whose secret signs the webhooks of a channel. WhatsApp and Messenger always answer to the
// main app. Instagram answers to its own app when the platform has one (`META_INSTAGRAM_APP_SECRET`)
// and to the main one when it does not, which is how the three channels are one app again later.
export const MetaWebhookApps = {
  MAIN: 'main',
  INSTAGRAM: 'instagram'
} as const

export type MetaWebhookApp = (typeof MetaWebhookApps)[keyof typeof MetaWebhookApps]

export const MetaGraph = {
  // The Graph host: WhatsApp, Messenger and Instagram (with the token of its Page) all use it. Instagram Login's
  // own host, graph.instagram.com, takes another kind of token and is not used. A call names this
  // origin, never a url of its own.
  ORIGIN: 'https://graph.facebook.com',
  // The one host that wants the connection token to give a file. Exact on purpose: other
  // *.fbsbx.com hosts (apps.fbsbx.com) serve content of third parties.
  MEDIA_TOKEN_HOSTS: ['lookaside.fbsbx.com'],
  FALLBACK_CONTENT_TYPE: 'application/octet-stream',
  // CDNs a media url may point to. They are followed without the token. A media url outside both
  // lists is refused, so a forged answer cannot make the worker call an internal address.
  MEDIA_CDN_SUFFIXES: ['.fbcdn.net', '.whatsapp.net', '.cdninstagram.com'],
  // Exact hosts of a CDN that need no token. Exact, like the one above: the other *.fbsbx.com hosts
  // serve content of third parties. Messenger puts its voice clips and files here.
  MEDIA_CDN_HOSTS: ['cdn.fbsbx.com']
} as const

// Statuses that say "not now" without being a 5xx: request timeout and too early
export const MetaTransientStatuses = [408, 425] as const

export const MetaLimits = {
  REQUEST_TIMEOUT_MS: 15_000,
  MEDIA_TIMEOUT_MS: 60_000,
  // An upload of the largest file (100 MB) over an ordinary uplink; a call that takes longer is cut
  UPLOAD_TIMEOUT_MS: 180_000,
  // WhatsApp accepts documents up to 100 MB, the largest media it carries
  MEDIA_MAX_BYTES: 100 * 1024 * 1024,
  // The challenge Meta sends is an integer
  CHALLENGE_MAX_DIGITS: 20
} as const

// The error codes of the Graph API (https://developers.facebook.com/docs/graph-api/guides/error-handling).
export const MetaErrorCodes = {
  // The token is expired, revoked or lacks the permission: the owner has to connect again
  INVALID_TOKEN: 190,
  PERMISSION_DENIED: 10,
  // `(#100) ...`: a field of the request that this token may not read answers it too
  INVALID_PARAMETER: 100,
  // 200 to 299 are permission errors as well
  PERMISSION_RANGE_START: 200,
  PERMISSION_RANGE_END: 299,
  // Throttling: Meta did not do the work, so trying again later is safe. 130429 and 131056 are the
  // WhatsApp Cloud API ones (throughput and pair rate limit)
  RATE_LIMITS: [
    4, 17, 32, 613, 80000, 80001, 80002, 80003, 80004, 80005, 80006, 80008, 80009, 80014, 130429,
    131056
  ],
  // Failure on Meta's side (131000 and 131016 are WhatsApp's): the work may or may not have been done
  TEMPORARY: [1, 2, 131000, 131016],
  // Messenger documents it: the person has no profile to read (an account made with a phone number).
  // Instagram documents no such code; there a person who cannot be read answers an error or nothing.
  NO_PROFILE: 2018218
} as const

export type MetaGraphOrigin = typeof MetaGraph.ORIGIN

// What Instagram and Messenger share on the wire (the Messenger Platform and the Instagram messaging
// API are the same shape on two hosts)
export const MetaMessaging = {
  EDGE_MESSAGES: 'messages',
  EDGE_SUBSCRIBED_APPS: 'subscribed_apps',
  // `sender_action` of the Send API
  ACTION_REACT: 'react',
  ACTION_UNREACT: 'unreact',
  ACTION_TYPING_ON: 'typing_on',
  ACTION_TYPING_OFF: 'typing_off',
  ACTION_MARK_SEEN: 'mark_seen',
  // `reaction.action` of the webhook
  REACTION_REACT: 'react',
  REACTION_UNREACT: 'unreact',
  RECIPIENT_ID_PATTERN: /^\d{1,32}$/,
  // The largest time a Date can hold is 8.64e15; a message is never dated that far ahead
  MAX_EPOCH_MS: 1e14,
  // The key that holds a file in the Send API: Instagram's reference writes it in the plural
  ATTACHMENT_KEY: 'attachment',
  ATTACHMENTS_KEY: 'attachments',
  ATTACHMENT_IMAGE: 'image',
  ATTACHMENT_VIDEO: 'video',
  ATTACHMENT_AUDIO: 'audio',
  ATTACHMENT_FILE: 'file',
  // `referral.source` of a Click-to-Message ad
  REFERRAL_SOURCE_ADS: 'ADS'
} as const

// Instagram messaging through the Messenger Platform with Facebook Login (Meta: "Get started with Instagram
// Messaging", developers.facebook.com/documentation/business-messaging/instagram-messaging/get-started):
// graph.facebook.com and the token of the Facebook Page linked to the account, pasted by the owner. The
// token is the Page's: `me` is the Page, and the account is the one it links. The connection is the
// account (its id is `entry.id` of the webhooks); the Page is kept in the connection's metadata.
export const InstagramApi = {
  WEBHOOK_OBJECT: 'instagram',
  // `me` with the Page token: the Page and the one Instagram account it links
  PAGE_ACCOUNT_FIELDS: 'id,instagram_business_account{id,username}',
  PAGE_ACCOUNT_KEY: 'instagram_business_account',
  // The Page behind the connection, in `ChannelConnection.metadata`: a token of another Page that
  // links the same account would otherwise pass as the connection's own
  METADATA_PAGE_ID: 'pageId',
  // The subscription belongs to the Page the token is of, and the id of the connection is the
  // account's, so the Page is addressed as `me`
  SUBSCRIBE_OWNER: 'me',
  // NOT VERIFIED against Meta's pages: the send guide of this variant could not be read. `me/messages`
  // with the Page token is the route Messenger uses and the historic one of Messenger API support for
  // Instagram. If the real send refuses it, the alternative is `<pageId>/messages` (the id is in the
  // metadata): this is the one place to change (IMPLEMENTATION_PLAN, Step 7.3, owner's real test).
  SEND_OWNER: 'me',
  // The customer behind a scoped id (User Profile API); `name` may come back null
  USER_PROFILE_FIELDS: 'name,username,profile_pic',
  // The names of the SUBSCRIPTION, which are not always the names of the webhook event (`messaging_referral`
  // arrives as `referral`, `message_reactions` as `reaction`).
  // Only what the Messenger Platform setup documents (webhooks/fields: each needs `instagram_manage_messages`).
  // `messaging_seen` is not subscribed: no parser reads its `read` event yet; `message_edit` is not
  // either: that setup does not list it, and a name Meta refuses fails the connection
  // (IMPLEMENTATION_PLAN, Step 7.3)
  SUBSCRIBED_FIELDS: 'messages,message_reactions,messaging_referral'
} as const

// Messenger Platform, with the token of the Page
export const MessengerApi = {
  WEBHOOK_OBJECT: 'page',
  USER_PROFILE_FIELDS: 'first_name,last_name,profile_pic',
  SUBSCRIBED_FIELDS: 'messages,message_echoes,message_reactions,message_edits,messaging_referrals',
  MESSAGING_TYPE_RESPONSE: 'RESPONSE',
  // `/me` with a Page token: `id` needs no permission, `name` needs `pages_read_engagement`
  PROFILE_ID_FIELD: 'id',
  // Name of the connection when the token cannot read the name of the Page: the prefix and the Page id
  FALLBACK_NAME_PREFIX: 'Messenger',
  PROFILE_NAME_FIELDS: 'id,name'
} as const

// Every `subscribed_fields` value each API accepts for POST /{id}/subscribed_apps, from Meta's
// reference (Instagram: the webhooks reference of the `instagram` object and the error text of
// graph.instagram.com, 2026-11-05; Messenger: the webhooks reference of the `page` object). A name outside the list is answered with error 100 and the connection fails, so the
// specs refuse it before Meta does.
export const MetaSubscribableFields = {
  INSTAGRAM: [
    'agent_messages',
    'comments',
    'live_comments',
    'message_edit',
    'message_reactions',
    'messages',
    'messaging_handover',
    'messaging_optins',
    'messaging_postbacks',
    'messaging_referral',
    'messaging_seen',
    'standby'
  ],
  MESSENGER: [
    'message_deliveries',
    'message_echoes',
    'message_edits',
    'message_reactions',
    'message_reads',
    'messages',
    'messaging_handovers',
    'messaging_optins',
    'messaging_postbacks',
    'messaging_referrals'
  ]
} as const
