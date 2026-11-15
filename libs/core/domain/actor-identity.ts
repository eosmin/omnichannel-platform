import { AuthorType } from './status-enums'

// Who did a change of the data: a person of the team (a row of `users`), a plugin that acts through its key (TDD_10 §6, it has no
// user) or the platform itself (a sweep, a webhook). The columns that used to hold only the id of a person take it from here, so
// that a plugin is never written under somebody's id (a foreign key would break, or a person would be named for what a plugin did).
// A service that records who did something takes this and not a bare user id; the contract for the services of other modules
// (orders, shipping...) is the same: take an `ActorIdentity`, store it with `actorColumnsOf`.
export const ActorKinds = {
  PERSON: 'person',
  PLUGIN: 'plugin',
  SYSTEM: 'system'
} as const
export type ActorKind = (typeof ActorKinds)[keyof typeof ActorKinds]

export type ActorIdentity =
  | { kind: typeof ActorKinds.PERSON; userId: string }
  | { kind: typeof ActorKinds.PLUGIN; pluginId: string }
  | { kind: typeof ActorKinds.SYSTEM }

// The three columns that say who did it in a table that has `*_type`, `*_id` and `*_plugin_id` (a message's edit and deletion, a
// revision): exactly one of the id and the plugin id is set for a person or a plugin, none for the platform. The type is `agent` for a
// person and `system` for the other two, the values the columns held before a plugin could write them.
export interface ActorColumns {
  type: AuthorType
  id: string | null
  pluginId: string | null
}

export function actorColumnsOf(actor: ActorIdentity): ActorColumns {
  switch (actor.kind) {
    case ActorKinds.PERSON:
      return { type: AuthorType.AGENT, id: actor.userId, pluginId: null }
    case ActorKinds.PLUGIN:
      return { type: AuthorType.SYSTEM, id: null, pluginId: actor.pluginId }
    case ActorKinds.SYSTEM:
      return { type: AuthorType.SYSTEM, id: null, pluginId: null }
  }
}
