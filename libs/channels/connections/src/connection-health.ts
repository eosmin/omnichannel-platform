// What the health round of a remote channel (libs/channels/remote) takes from the connections library, without the module of
// the library: that one reaches the env, and a unit spec must not (see `oauth-callback.ts`, which is apart for the same reason)
export { CONNECTION_ROW_SELECT } from './channel-context.factory'
export { ChannelHealthService, type CheckedHealth } from './channel-health.service'
export { errorName } from './timeout'
