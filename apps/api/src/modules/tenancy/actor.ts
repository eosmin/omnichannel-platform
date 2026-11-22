import type { AuthenticatedUser } from '@platform/core/auth'
import {
  type Actor,
  type ActorIdentity,
  ActorKinds,
  auditActorOf,
  auditViaOf,
  PLUGIN_ACTOR_PREFIX
} from '@platform/core/domain'
import type { AuthenticatedRequest } from '@platform/core/logger'

// Moved to `@platform/core/domain` (7.2-H2a) so the worker shares it; re-exported so every import of the api stays
export { type Actor, auditActorOf, auditViaOf }

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
  installation: { id: string; pluginId: string },
  store: { id: string },
  request: AuthenticatedRequest
): Actor {
  return {
    userId: pluginUserId(installation.id),
    pluginId: installation.pluginId,
    storeId: store.id,
    ipAddress: request.ip,
    userAgent: request.get('user-agent'),
    pluginInstallationId: installation.id
  }
}

// Who the columns of authorship record for an actor (`ActorIdentity`, PR M1c): a person by the id of the user, a plugin by the id of
// the plugin and never as a user, because `plugin:<installation id>` is not a row of `users`. A plugin actor with no plugin id is a
// bug of the caller that built it (`pluginActorOf` always sets it), so it is refused and not recorded as nobody.
export function identityOf(actor: Actor): ActorIdentity {
  if (actor.pluginInstallationId === undefined) {
    return { kind: ActorKinds.PERSON, userId: actor.userId }
  }
  if (actor.pluginId === undefined) {
    throw new Error('a plugin actor must carry the id of its plugin (build it with pluginActorOf)')
  }
  return { kind: ActorKinds.PLUGIN, pluginId: actor.pluginId }
}
