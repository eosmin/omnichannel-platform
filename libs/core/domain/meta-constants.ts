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
  // The field that carries the file when it is uploaded and sent in one call (Send API)
  SEND_FILE_FIELD: 'filedata',
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
  // What Meta says about a token: `GET` is the documented method; `POST` is tried first so that the token
  // that is being asked about does not travel in the address
  DEBUG_TOKEN_EDGE: 'debug_token',
  DEBUG_TOKEN_INPUT_FIELD: 'input_token',
  // The one host that wants the connection token to give a file. Exact on purpose: other
  // *.fbsbx.com hosts (apps.fbsbx.com) serve content of third parties.
  MEDIA_TOKEN_HOSTS: ['lookaside.fbsbx.com'],
  FALLBACK_CONTENT_TYPE: 'application/octet-stream',
  // What an audio of the webhook is taken to be until the file says otherwise (a clip in an mp4 container)
  AUDIO_HINT_CONTENT_TYPE: 'audio/mp4',
  // CDNs a media url may point to. They are followed without the token. A media url outside both
  // lists is refused, so a forged answer cannot make the worker call an internal address.
  MEDIA_CDN_SUFFIXES: ['.fbcdn.net', '.whatsapp.net', '.cdninstagram.com'],
  // Exact hosts of a CDN that need no token. Exact, like the one above: the other *.fbsbx.com hosts
  // serve content of third parties. Messenger puts its voice clips and files here.
  MEDIA_CDN_HOSTS: ['cdn.fbsbx.com'],
  // The GIFs of Instagram are Giphy's and Tenor's, not Meta's (owner's test, 2026-11-08: media1 and media4
  // of Giphy). Only for the link a customer sent, never for a url that Graph answers. A closed list of
  // exact hosts: never `*.giphy.com` or a whole domain, which would let anyone who can put a file there
  // reach the worker. The client checks the host, https, no port or credentials and no redirect; the worker checks the address and the size, type and scan, and must keep doing so for these third-party hosts.
  MEDIA_GIF_HOSTS: [
    'media0.giphy.com',
    'media1.giphy.com',
    'media2.giphy.com',
    'media3.giphy.com',
    'media4.giphy.com',
    'i.giphy.com',
    'media.tenor.com',
    'c.tenor.com'
  ] as readonly string[]
} as const

// Statuses that say "not now" without being a 5xx: request timeout and too early
export const MetaTransientStatuses = [408, 425] as const

export const MetaLimits = {
  REQUEST_TIMEOUT_MS: 15_000,
  // How long the process remembers which method `debug_token` took: after it the POST is tried again, so that
  // a fallback to GET (the token in the address) is not kept for ever by one odd answer
  DEBUG_METHOD_MEMORY_MS: 3_600_000,
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
    4, 17, 32, 613, 80000, 80001, 80002, 80003, 80004, 80005, 80006, 80007, 80008, 80009, 80010,
    80011, 80012, 80013, 80014, 130429, 131056
  ],
  // Failure on Meta's side (131000 and 131016 are WhatsApp's): the work may or may not have been done
  TEMPORARY: [1, 2, 131000, 131016],
  // Meta's answer to a method an edge does not support (a POST to `debug_token`): the class of the error, read
  // by shape and never by the text, which changes with the language of the app. Its code and subcode (100, 33)
  // are also those of "the object does not exist or is not yours", so they do not say it alone.
  METHOD_REJECTED_ERROR_TYPE: 'GraphMethodException',
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
  // The key that holds a file in the Send API
  ATTACHMENT_KEY: 'attachment',
  ATTACHMENT_IMAGE: 'image',
  ATTACHMENT_VIDEO: 'video',
  ATTACHMENT_AUDIO: 'audio',
  ATTACHMENT_FILE: 'file',
  // `referral.source` of a Click-to-Message ad
  REFERRAL_SOURCE_ADS: 'ADS',
  // The attachment of a place the customer shared: `payload.coordinates` holds `{ lat, long }`
  ATTACHMENT_LOCATION: 'location',
  // Instagram shares a place as a template of elements (a title, a subtitle, a link to a map)
  ATTACHMENT_TEMPLATE: 'template',
  // How much of a template is read: a card has one element and a few buttons
  TEMPLATE_MAX_ELEMENTS: 3,
  TEMPLATE_MAX_BUTTONS: 3,
  ATTACHMENT_STICKER: 'sticker',
  // The like button of Messenger arrives as a sticker with this id (and, until Meta stops sending the
  // pair, as an image with the same link). It is the thumbs up, not a file worth fetching.
  LIKE_STICKER_ID: '369239263222822',
  // The three sizes of the like (a tap, a short press, a long press) are three stickers: small, medium and
  // large, all the same thumbs up. Verified only by Meta's documentation, not by a raw webhook yet (owner
  // test 2026-11-08 saw the medium and the large arrive as stickers with an id); an id that is not here is
  // a sticker like any other, never guessed to be a like.
  LIKE_STICKER_IDS: ['369239263222822', '369239343222814', '369239383222810'] as readonly string[],
  LIKE_TEXT: '\u{1F44D}',
  // The texts Messenger puts beside a photo sent from the camera roll: a placeholder, not something the
  // customer wrote. An exact list and not a pattern, because "[ok]" with a photo can be a customer's
  // words and dropping it loses them; a new one is added when a real payload shows it.
  PLACEHOLDER_TEXTS: ['[Adjuntar foto]'] as readonly string[]
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
  // The names of the SUBSCRIPTION on the Page edge (`POST me/subscribed_apps` with the Page token), which
  // are the names of the `MetaSubscribableFields.PAGE` enum and not those of the `instagram` object:
  // the singular `messaging_referral` is refused there with error 100, the plural is the Page's name
  // (Meta's reference of the edge). The webhook event is still `referral`, whatever the name.
  // `messaging_seen` and `message_edit` are not names of the Page edge, and no parser reads `read`
  // yet (IMPLEMENTATION_PLAN, Step 7.3). The fields are the same three that Messenger asks for, so
  // the two channels share them on the Page.
  SUBSCRIBED_FIELDS: 'messages,message_reactions,messaging_referrals'
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

// The `subscribed_fields` values the Page edge accepts for POST <page>/subscribed_apps, for Messenger and for
// Instagram with a Page token alike: the messaging names of the enum in Meta's reference of the edge
// (graph-api/reference/page/subscribed_apps, "Creating > Parameters", read 2026-11-05). A name outside the
// list is answered with error 100 and the connection fails, so the specs refuse it before Meta does. The
// list is copied by hand from that page and NOT checked against a live call: the owner's real test
// (IMPLEMENTATION_PLAN, Step 7.3) is what confirms it. The names of the `instagram` object
// (`messaging_referral`, `messaging_seen`, `message_edit`) are not in it, and no list of them is kept:
// nothing here calls that edge, and a list of the wrong edge is how the first Page connect failed.
export const MetaSubscribableFields = {
  PAGE: [
    'standby',
    'messages',
    'message_reactions',
    'message_echoes',
    'message_edits',
    'message_deliveries',
    'message_reads',
    'message_context',
    'messaging_optins',
    'messaging_postbacks',
    'messaging_referrals',
    'messaging_handovers',
    'messaging_policy_enforcement',
    'response_feedback',
    'messaging_feedback'
  ]
} as const

// The subscription of an app to the webhooks of a Page (`<page>/subscribed_apps`). One POST sets the
// fields of the app on that Page and Messenger and Instagram share the Page, so a connection reads
// what the app already has and posts the union (Meta does not say whether a POST replaces or adds).
export const MetaSubscription = {
  // `GET app?fields=id` with the token: the app the token belongs to
  APP_EDGE: 'app',
  APP_ID_FIELD: 'id',
  // A field name that goes back to Meta in a URL: lowercase words, digits and underscores
  FIELD_NAME_PATTERN: /^[a-z][a-z0-9_]{0,63}$/,
  // The id of an app, as the Graph writes it
  APP_ID_PATTERN: /^\d{1,32}$/,
  // No Page has near this many fields; a longer list is not what Meta answers
  MAX_FIELDS: 64
} as const

// The maps whose links hold the coordinates of a place a customer shares (Instagram sends it as a template).
// EXACT hosts only: a subdomain or a look-alike is no map. Other regional domains of Google are added here.
export const MapLinks = {
  GOOGLE_HOSTS: [
    'www.google.com',
    'google.com',
    'maps.google.com',
    'www.google.com.sv',
    'google.com.sv',
    'www.google.com.mx',
    'google.com.mx'
  ],
  APPLE_HOSTS: ['maps.apple.com'],
  OSM_HOSTS: ['www.openstreetmap.org', 'openstreetmap.org'],
  // The links Instagram and Facebook put in front of an outside link: followed once, and only to a map
  REDIRECT_HOSTS: ['l.instagram.com', 'l.facebook.com', 'lm.facebook.com'],
  REDIRECT_PARAM: 'u',
  // Parameters that name the place itself (a viewport centre or a search centre is not the place)
  GOOGLE_PLACE_PARAMS: ['query', 'q', 'destination'],
  APPLE_PLACE_PARAMS: ['coordinate'],
  GOOGLE_MAPS_HOST: 'maps.google.com',
  GOOGLE_MAPS_PATH: /^\/maps(?:\/|$)/,
  GOOGLE_PLACE_PATH: '/maps/place/',
  OSM_MARKER_PARAMS: ['mlat', 'mlon'],
  // The text of a title or subtitle that is read: longer is cut before it is cleaned
  TEMPLATE_TEXT_MAX_LENGTH: 300
} as const

// The only hosts that serve the thumbnail of the story an Instagram customer answered
// (`reply_to.story.url`). Exact host names, no wildcard: `*.fbsbx.com` also holds hosts that serve content of
// third parties. The Instagram plugin keeps a story link only when it is https on one of these, and the CSP of the
// web (`img-src`) allows the same list, so the two cannot drift.
export const MetaStoryImageHosts = ['lookaside.fbsbx.com'] as const
