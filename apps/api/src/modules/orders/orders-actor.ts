import { ActorKinds, PLUGIN_ACTOR_PREFIX } from '@platform/core/domain'
import type { ActorRef } from '@platform/core/events'

import { type Actor, identityOf } from '../tenancy/actor'

// Who an order says did something (Step 5.6 PR E3b). Pure on purpose: no module of the database or of the environment, so its spec
// runs without them.

// Who the events of an order say did it. A plugin is the platform here: the listeners that read the actor take its id for a row of
// `users` (who to leave out of a notification, who asked for a message), and a plugin has none (PR E3b)
export const actorRef = (actor: Actor): ActorRef => {
  const who = identityOf(actor)
  return who.kind === ActorKinds.PERSON
    ? { type: 'user', id: who.userId }
    : { type: 'system', id: null }
}

// The two columns that say who did it, for a table that holds a person beside a plugin: one is set and the other null, the check
// of the migration of PR E3b. A plugin is never written under a person's id (the contract of PR M1c).
export interface ActorIds {
  userId: string | null
  pluginId: string | null
}

// One string for who it is, to tell whether two columns name the same actor (a person, or a plugin: `plugin:` can never be the
// start of the uuid of a user). Null when neither is set.
export function actorKeyOf(ids: ActorIds): string | null {
  if (ids.userId !== null) return ids.userId
  return ids.pluginId === null ? null : `${PLUGIN_ACTOR_PREFIX}${ids.pluginId}`
}

export function actorIds(actor: Actor): ActorIds {
  const who = identityOf(actor)
  return who.kind === ActorKinds.PLUGIN
    ? { userId: null, pluginId: who.pluginId }
    : { userId: actor.userId, pluginId: null }
}
