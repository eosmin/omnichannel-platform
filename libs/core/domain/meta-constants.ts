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

export const MetaGraph = {
  // The Graph host: WhatsApp, Messenger and Instagram (unified login) all use it. Instagram Login's
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

// Instagram messaging with the unified login (https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-unified-login):
// graph.facebook.com and the token of a system user of the owner's business, pasted by the owner. The
// token is not an account: `me` is its system user, and the accounts the owner shared with the app are
// the edge below it.
export const InstagramApi = {
  WEBHOOK_OBJECT: 'instagram',
  ACCOUNTS_EDGE: 'assigned_instagram_accounts',
  // The id is the one of the webhooks (`entry.id`) and of every path after it
  PROFILE_FIELDS: 'id,username',
  // Graph pages at 25; a business shares far fewer accounts than this with one app
  ACCOUNTS_PAGE_LIMIT: '100',
  // The customer behind a scoped id (User Profile API); `name` may come back null
  USER_PROFILE_FIELDS: 'name,username,profile_pic',
  // The names of the SUBSCRIPTION, which are not always the names of the webhook event (`messaging_referral`
  // arrives as `referral`, `message_reactions` as `reaction`, `message_edit` as `message_edit`).
  // `messaging_seen` is not subscribed: no parser reads its `read` event yet (IMPLEMENTATION_PLAN, Step 7.3)
  SUBSCRIBED_FIELDS: 'messages,message_reactions,messaging_referral,message_edit'
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
