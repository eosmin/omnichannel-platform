import { PLUGIN_ACTOR_PREFIX } from '@platform/core/domain'

// Who asked for an export, as the worker treats them: `requestedBy` is the id of a person, or `plugin:<installation id>` for a plugin (Step
// 5.6 PR E7), which is no row of `users`: its audit entry is the system's with the installation in the metadata (the column of the user is a
// foreign key), and nobody is told when its file is ready, because it polls `GET /plugin-api/exports/:id`.
export function isPluginRequester(requestedBy: string): boolean {
  return requestedBy.startsWith(PLUGIN_ACTOR_PREFIX)
}

export function auditActorOfRequester(requestedBy: string): { userId: string } | { system: true } {
  return isPluginRequester(requestedBy) ? { system: true } : { userId: requestedBy }
}

export function auditViaOfRequester(requestedBy: string): { pluginInstallationId?: string } {
  return isPluginRequester(requestedBy)
    ? { pluginInstallationId: requestedBy.slice(PLUGIN_ACTOR_PREFIX.length) }
    : {}
}
