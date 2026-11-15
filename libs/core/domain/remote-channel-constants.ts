// The words and the numbers of the commands the platform sends to a channel plugin that runs outside it
// (TDD_10 §6.7.4). Nothing here names a channel: a remote plugin is whatever its manifest says.

// The `command` of the body POSTed to `commandsUrl`
export const RemoteChannelCommands = {
  MESSAGE_SEND: 'message.send',
  CONNECTION_HEALTH: 'connection.health',
  CONNECTION_DISCONNECT: 'connection.disconnect',
  TYPING_SEND: 'typing.send',
  MESSAGE_MARK_READ: 'message.markRead'
} as const

export type RemoteChannelCommand =
  (typeof RemoteChannelCommands)[keyof typeof RemoteChannelCommands]

// The headers of a command. They have nothing to do with the webhook headers of TDD_07 §2.
export const RemoteChannelHeaders = {
  SIGNATURE: 'x-platform-command-signature',
  DELIVERY: 'x-platform-delivery',
  IDEMPOTENCY_KEY: 'idempotency-key'
} as const

// The `type` of `message.send` and of the media it carries
export const RemoteChannelSendTypes = {
  TEXT: 'text',
  IMAGE: 'image',
  VIDEO: 'video',
  AUDIO: 'audio',
  DOCUMENT: 'document'
} as const

export type RemoteChannelSendType =
  (typeof RemoteChannelSendTypes)[keyof typeof RemoteChannelSendTypes]

// The `state` of `typing.send`
export const RemoteTypingStates = { START: 'start', STOP: 'stop' } as const

// The `code` a plugin gives when it refuses a command (HTTP 4xx or 5xx with `{ error: { code } }`)
export const RemoteChannelErrorCodes = {
  RECIPIENT_INVALID: 'recipient_invalid',
  WINDOW_CLOSED: 'window_closed',
  NOT_CONNECTED: 'not_connected',
  RATE_LIMITED: 'rate_limited',
  REJECTED: 'rejected'
} as const

export type RemoteChannelErrorCode =
  (typeof RemoteChannelErrorCodes)[keyof typeof RemoteChannelErrorCodes]

export const RemoteChannelLimits = {
  // What the platform sends and what it reads back, per command
  MAX_REQUEST_BYTES: 256 * 1024,
  MAX_RESPONSE_BYTES: 64 * 1024,
  // A send or a health check waits this long; typing and read marks are best effort and wait less
  COMMAND_TIMEOUT_MS: 10_000,
  BEST_EFFORT_TIMEOUT_MS: 3_000,
  // The plugin refuses a `t` farther than this from its clock; the platform signs with its own
  SIGNATURE_TOLERANCE_SECONDS: 300,
  // The signed GET of the file of an outbound message
  MEDIA_URL_TTL_SECONDS: 600,
  // What the platform offers a remote channel before the plugin says more: the text of a message (the cap of an inbound one, §6.7.5),
  // and how many files go in one message (each is a command of its own)
  TEXT_MAX_LENGTH: 4096,
  MAX_FILES_PER_MESSAGE: 10,
  // The secret of the commands: 32 random bytes
  SECRET_BYTES: 32,
  // After a rotation the previous secret still signs for this long (every command carries both signatures)
  ROTATION_GRACE_SECONDS: 600,
  // The installation of a store (url, secrets) is read through a cache of this life, which the Redis channel clears
  INSTALLATION_CACHE_SECONDS: 60,
  // Every remote plugin is read again from the database this often, in case a message was lost
  REREAD_INTERVAL_SECONDS: 60
} as const

// The Redis channel on which a process says that the remote plugins changed (an install, a revoke, a suspension, a new
// manifest, a rotation): every other process reads them again
export const PLUGINS_CHANGED_CHANNEL = 'plugins:changed'

// How a remote plugin's health is judged (TDD_10 §6.7.7): this many failed checks in a row put the connection in
// error, a healthy one clears the count
export const RemoteChannelHealthLimits = {
  FAILURES_TO_ERROR: 3,
  FAILURES_TTL_SECONDS: 3600,
  CONCURRENCY: 10
} as const

// The scheme of the signature header: `t=<unix seconds>,v1=<hex>[,v1=<hex>]`
export const REMOTE_SIGNATURE_TIME_KEY = 't'
export const REMOTE_SIGNATURE_VERSION_KEY = 'v1'
