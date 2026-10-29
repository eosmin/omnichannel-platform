// The web widget (TDD_10 §5.4): a script on the store's own site that a visitor chats from. The site
// key is the public id of the connection; the token a visitor gets from the bootstrap is the only
// credential of everything else.
export const WidgetLimits = {
  SITE_KEY_PREFIX: 'pk_widget_',
  // Random bytes behind the prefix; the key is their base64url, 24 characters
  SITE_KEY_BYTES: 18,
  // The sites that may load the widget: a store has a few
  MAX_ORIGINS: 20,
  MAX_ORIGIN_LENGTH: 200,
  // What a visitor may write in one message
  CONTENT_MAX_LENGTH: 2000,
  // The id the browser gives a message so that sending it twice stores it once
  CLIENT_MESSAGE_ID_MAX_LENGTH: 64,
  TOKEN_TTL_SECONDS: 3600,
  // How much of the conversation the bootstrap hands back
  HISTORY_MESSAGES: 50,
  // A visitor has a few tabs open
  MAX_SOCKETS_PER_VISITOR: 5
} as const

// A visitor id is made by the widget script (a random UUID kept in the browser of the visitor)
export const VISITOR_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// What the web widget plugin keeps in `ChannelConnection.metadata`
export const WidgetMetadataKeys = {
  ALLOWED_ORIGINS: 'allowedOrigins'
} as const

// Who wrote a message, as the visitor sees it. The team, a bot and the owner typing elsewhere are one
// side to the visitor.
export const WidgetAuthors = {
  VISITOR: 'visitor',
  TEAM: 'team'
} as const
export type WidgetAuthor = (typeof WidgetAuthors)[keyof typeof WidgetAuthors]

// The events the visitor's socket receives (namespace `RealtimeNamespaces.WIDGET`). The payload is the
// message itself: the room is the one visitor's, and what it carries was written for them.
export const WidgetSocketEvents = {
  MESSAGE: 'widget.message'
} as const

// Anyone on the internet can call these: per address, and far below the webhook limit
export const WidgetThrottle = {
  BOOTSTRAP: { limit: 30, ttlMs: 60_000 },
  MESSAGES: { limit: 60, ttlMs: 60_000 }
} as const

// Where the token travels: in this header for the check that stands for a provider's signature, and
// in `auth` of the handshake of the socket
export const WIDGET_TOKEN_HEADER = 'x-widget-token'
export const WIDGET_TOKEN_AUTH_KEY = 'token'
