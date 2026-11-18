import { allowLocalCommandsUrl } from '@platform/core/url-safety'

// Tells the process whether a channel plugin of the suites may answer on this machine (`PLUGIN_ALLOW_LOCAL_COMMANDS_URL`), from the
// validated env. Called while the http platform module is described, which happens when the app module is loaded: before Nest builds
// any provider, so before any manifest is read or any plugin is called. Off by default; only NODE_ENV=test with the switch on turns it
// on (the env schema refuses the switch elsewhere, and `allowLocalCommandsUrl` asks for the test environment again).
export function applyLocalCommandsUrlPolicy(env: {
  NODE_ENV: string
  PLUGIN_ALLOW_LOCAL_COMMANDS_URL: boolean
}): void {
  allowLocalCommandsUrl({ nodeEnv: env.NODE_ENV, flag: env.PLUGIN_ALLOW_LOCAL_COMMANDS_URL })
}
