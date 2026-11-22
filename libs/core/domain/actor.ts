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
