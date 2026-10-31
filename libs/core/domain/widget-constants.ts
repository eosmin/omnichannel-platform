import { CustomerLimits } from './customer-constants'
// The web widget (TDD_10 §5.4): a script on the store's own site that a visitor chats from. The site
// key is the public id of the connection; the token a visitor gets from the bootstrap is the only
// credential of everything else.
export const WidgetLimits = {
  // The least time between two typing signals the server takes from one visitor, in all their tabs
  CUSTOMER_TYPING_GAP_MS: 2_000,
  // How long the widget shows "the team is typing" with no stop from the server: the agent's client
  // repeats a start every 5 s while they type, so a start that is not renewed has gone stale
  AGENT_TYPING_LAPSE_MS: 25_000,
  // The most typing signals the server takes from one site in a minute, whoever sends them
  CUSTOMER_TYPING_SITE_PER_MINUTE: 600,
  CUSTOMER_TYPING_SITE_WINDOW_MS: 60_000,
  SITE_KEY_PREFIX: 'pk_widget_',
  // Random bytes behind the prefix; the key is their base64url, 24 characters
  SITE_KEY_BYTES: 18,
  // The sites that may load the widget: a store has a few
  MAX_ORIGINS: 20,
  MAX_ORIGIN_LENGTH: 200,
  // What a visitor may type in the pre-chat form (the name has the limit of a customer's name)
  PROFILE_FIELD_MAX_LENGTH: CustomerLimits.EMAIL_MAX_LENGTH,
  // What a visitor may write in one message
  CONTENT_MAX_LENGTH: 2000,
  // The id the browser gives a message so that sending it twice stores it once
  CLIENT_MESSAGE_ID_MAX_LENGTH: 64,
  TOKEN_TTL_SECONDS: 3600,
  // How much of the conversation the bootstrap hands back
  HISTORY_MESSAGES: 50,
  // A visitor has a few tabs open
  MAX_SOCKETS_PER_VISITOR: 5,
  // What the script a store pastes into its site may weigh once compressed (TDD_10 §5.4)
  BUNDLE_MAX_GZIP_BYTES: 40 * 1024
} as const

// A visitor id is made by the widget script (a random UUID kept in the browser of the visitor)
export const VISITOR_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// What the web widget plugin keeps in `ChannelConnection.metadata`
export const WidgetMetadataKeys = {
  ALLOWED_ORIGINS: 'allowedOrigins',
  // Whether the widget asks a visitor for a name, an email and a phone before the first message
  PRE_CHAT_ENABLED: 'preChatEnabled'
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
  MESSAGE: 'widget.message',
  // The team is typing a reply: `{ active }`, and the visitor's widget
  // lets it lapse by itself (`WidgetLimits.AGENT_TYPING_LAPSE_MS`) if no stop arrives
  AGENT_TYPING: 'widget.agent_typing',
  // An agent read the conversation: `{ messageId }`, the latest message of the visitor at that moment.
  // That one and every earlier message of the visitor is seen
  READ: 'widget.read'
} as const

// What the visitor's socket sends the server (the one thing the namespace listens to): the visitor is
// typing, with no payload
export const WidgetClientEvents = {
  TYPING: 'widget.typing'
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

// The state of a message the visitor wrote, as the widget shows it
export const WidgetDeliveryStates = {
  SENDING: 'sending',
  SENT: 'sent',
  FAILED: 'failed'
} as const
export type WidgetDeliveryState = (typeof WidgetDeliveryStates)[keyof typeof WidgetDeliveryStates]

// What socket.io-client says about its own connection, which the widget reacts to
export const SocketLifecycle = {
  DISCONNECT: 'disconnect',
  CONNECT_ERROR: 'connect_error',
  // The reason of a disconnect that the server asked for: the library does not reconnect after it
  SERVER_DISCONNECT: 'io server disconnect'
} as const
