// The kinds of plugin the SDK defines. An integration plugin (TDD_10 §6) is not an SDK type: it
// talks to the plugin API and implements no interface.
export const PluginTypes = {
  CHANNEL: 'channel',
  CARRIER: 'carrier'
} as const
