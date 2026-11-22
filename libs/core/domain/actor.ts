// Who did it, and from where: what the audit entry of every change records. Shared by the api and the worker, so that a service
// that both run (the erasure of a customer) takes the same actor in either
export interface Actor {
  userId: string
  storeId: string
  ipAddress?: string | undefined
  userAgent?: string | undefined
  // Set when the caller is a plugin: `userId` is then `plugin:<installation id>`, not a row of `users`
  pluginInstallationId?: string | undefined
  // The plugin itself (the row of `plugins`), the one the columns of authorship hold (`ActorIdentity`): set with the installation
  pluginId?: string | undefined
  // Set only by a sweep of the worker that acts for the platform itself (the erasure of an approved data request, Step 7.2-H2b-1): there is
  // no person, `userId` is a label that never reaches a column of a user, and the audit records the system. No request of the api builds an
  // actor from a body, a header or a token with these two fields (the actor of a request is made by the tenancy module from the token).
  system?: true | undefined
  // The data request the sweep acts for: goes to the metadata of the audit entry so each erasure points to the request that caused it
  dsrRequestId?: string | undefined
}

// What the audit log records for an actor: a person by id, a plugin as the system with its installation in the metadata (the
// column of the user is a foreign key to `users`)
export function auditActorOf(actor: Actor): { userId: string } | { system: true } {
  return actor.pluginInstallationId === undefined && actor.system !== true
    ? { userId: actor.userId }
    : { system: true }
}

export function auditViaOf(actor: Actor): {
  pluginInstallationId?: string
  dsrRequestId?: string
} {
  return {
    ...(actor.pluginInstallationId === undefined
      ? {}
      : { pluginInstallationId: actor.pluginInstallationId }),
    ...(actor.dsrRequestId === undefined ? {} : { dsrRequestId: actor.dsrRequestId })
  }
}
