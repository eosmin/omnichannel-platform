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

export const MetaGraph = {
  // The two Graph hosts. Facebook's serves WhatsApp and Messenger; Instagram Login tokens only work on
  // Instagram's. A call names one of these, never a url of its own.
  ORIGIN: 'https://graph.facebook.com',
  INSTAGRAM_ORIGIN: 'https://graph.instagram.com',
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

export type MetaGraphOrigin = typeof MetaGraph.ORIGIN | typeof MetaGraph.INSTAGRAM_ORIGIN

// What Instagram and Messenger share on the wire (the Messenger Platform and the Instagram messaging
// API are the same shape on two hosts)
export const MetaMessaging = {
  EDGE_MESSAGES: 'messages',
  EDGE_SUBSCRIBED_APPS: 'subscribed_apps',
  // `sender_action` of the Send API
  ACTION_REACT: 'react',
  ACTION_UNREACT: 'unreact',
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

// Instagram messaging with Instagram Login (https://developers.facebook.com/docs/instagram-platform)
export const InstagramApi = {
  WEBHOOK_OBJECT: 'instagram',
  PROFILE_FIELDS: 'user_id,username',
  // The customer behind a scoped id (User Profile API); `name` may come back null
  USER_PROFILE_FIELDS: 'name,username,profile_pic',
  SUBSCRIBED_FIELDS: 'messages,messaging_referrals,messaging_reactions'
} as const

// Messenger Platform, with the token of the Page
export const MessengerApi = {
  WEBHOOK_OBJECT: 'page',
  PROFILE_FIELDS: 'id,name',
  USER_PROFILE_FIELDS: 'first_name,last_name,profile_pic',
  SUBSCRIBED_FIELDS: 'messages,message_echoes,message_reactions,messaging_referrals',
  MESSAGING_TYPE_RESPONSE: 'RESPONSE'
} as const
