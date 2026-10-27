const RECHECK_SECONDS = 30
const SILENT_SECONDS = 120

// What the gateway asks of a socket and of the client that holds it
export const SocketLimits = {
  // How often the server checks, with no help from the client, that a socket still has the right to
  // be open: its token, its membership, the conversations it joined
  RECHECK_SECONDS,
  // A person has a few conversations open; a socket in more is a loop
  MAX_CONVERSATION_ROOMS: 20,
  // Heartbeats closer than this are ignored: the client sends one every 30 s
  MIN_HEARTBEAT_GAP_SECONDS: 5,
  // A user has a laptop, a phone and a few tabs
  MAX_SOCKETS_PER_USER: 10,
  // A message from a client is a few dozen bytes: anything bigger is not one
  MAX_MESSAGE_BYTES: 16 * 1024,
  // A client that has not said who it is by now is not going to
  CONNECT_TIMEOUT_MS: 10_000,
  // Of everything a socket sends, typing included: above it the socket is cut off, because no client
  // sends that many
  MAX_EVENTS_PER_WINDOW: 200,
  // What one socket may ask of the database per window (a join, a typing start): more than a person
  // does, less than a loop. Above it the event is dropped.
  MAX_DB_EVENTS_PER_WINDOW: 40,
  WINDOW_SECONDS: 10,
  // Handshakes of one user per minute, refused ones included: each costs a database read
  MAX_HANDSHAKES_PER_MINUTE: 120,
  // Handshakes from one address per minute, counted before the token is looked at: a team behind
  // one address reconnecting together after a deploy stays well under it, a loop does not
  MAX_HANDSHAKES_PER_ADDRESS_PER_MINUTE: 300,
  HANDSHAKE_WINDOW_SECONDS: 60,
  // A socket that has sent no heartbeat and no typing in this long is closed: the client sends one
  // every 30 s, and without this a client that never does would hold sockets the cap cannot see
  SILENT_SECONDS,
  // A socket counts toward the cap of its user until it has been silent this long: past the time
  // the gateway lets one stay silent (SILENT_SECONDS) and the look that closes it (RECHECK_SECONDS)
  COUNTS_FOR_CAP_SECONDS: SILENT_SECONDS + RECHECK_SECONDS,
  // Shutting down does not wait longer than this for Redis
  CLOSE_TIMEOUT_MS: 2000
} as const
