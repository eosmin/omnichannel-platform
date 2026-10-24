// online: an open socket and activity in the last 5 minutes. away: an open socket, idle for more
// than 5 minutes. offline: no open socket (a dead connection expires on its own after 60 s).
export enum PresenceStatus {
  ONLINE = 'online',
  AWAY = 'away',
  OFFLINE = 'offline'
}
