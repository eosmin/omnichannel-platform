import type { AuthenticatedUser } from '@platform/core/auth'
import { PLUGIN_ACTOR_PREFIX } from '@platform/core/domain'
import type { AuthenticatedRequest } from '@platform/core/logger'

// Who did it, and from where: what the audit entry of every change records
export interface Actor {
  userId: string
  storeId: string
  ipAddress?: string | undefined
  userAgent?: string | undefined
  // Set when the caller is a plugin: `userId` is then `plugin:<installation id>`, not a row of `users`
  pluginInstallationId?: string | undefined
}

export function actorOf(
  user: AuthenticatedUser,
  store: { id: string },
  request: AuthenticatedRequest
): Actor {
  return {
    userId: user.id,
    storeId: store.id,
    ipAddress: request.ip,
    userAgent: request.get('user-agent')
  }
}

// The id the inbox services see for a plugin: never the id of a person
export function pluginUserId(installationId: string): string {
  return `${PLUGIN_ACTOR_PREFIX}${installationId}`
}

export function pluginActorOf(
  installation: { id: string },
  store: { id: string },
  request: AuthenticatedRequest
): Actor {
  return {
    userId: pluginUserId(installation.id),
    storeId: store.id,
    ipAddress: request.ip,
    userAgent: request.get('user-agent'),
    pluginInstallationId: installation.id
  }
}

// What the audit log records for an actor: a person by id, a plugin as the system with its installation in the metadata (the
// column of the user is a foreign key to `users`)
export function auditActorOf(actor: Actor): { userId: string } | { system: true } {
  return actor.pluginInstallationId === undefined ? { userId: actor.userId } : { system: true }
}

export function auditViaOf(actor: Actor): { pluginInstallationId?: string } {
  return actor.pluginInstallationId === undefined
    ? {}
    : { pluginInstallationId: actor.pluginInstallationId }
}
