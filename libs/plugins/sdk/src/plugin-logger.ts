import type { Logger } from 'pino'

// A plugin logs through a child of the logger the host gives it, so that the redaction and the
// format of the platform apply to it and the SDK keeps no second logger configuration
export function createPluginLogger(parent: Logger, pluginId: string): Logger {
  return parent.child({ pluginId })
}
