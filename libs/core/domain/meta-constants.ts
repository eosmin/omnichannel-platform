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

export type MetaGraphOrigin = typeof MetaGraph.ORIGIN

// The only hosts that serve the thumbnail of the story an Instagram customer answered
// (`reply_to.story.url`). Exact host names, no wildcard: `*.fbsbx.com` also holds hosts that serve content of
// third parties. The Instagram plugin keeps a story link only when it is https on one of these, and the CSP of the
// web (`img-src`) allows the same list, so the two cannot drift.
export const MetaStoryImageHosts = ['lookaside.fbsbx.com'] as const
