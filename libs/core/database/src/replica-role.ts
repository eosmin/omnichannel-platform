// What the api checks about the role of DATABASE_REPLICA_URL when it starts (F6-1 debt iii, closed in F6-5): a replica handle must not be
// able to write. A real standby refuses every write whatever the role is, so a role with write privileges is fine THERE; a replica that is
// a plain database (the primary under another URL, a copy that is not in recovery) is safe only because of the role.
// Pure: the facts come from `REPLICA_ROLE_FACTS_SQL`, the decision is here so a unit spec can read it without a database.

export interface ReplicaRoleFacts {
  roleName: string
  isSuperuser: boolean
  bypassesRls: boolean
  // INSERT or UPDATE on the table or on any column of it, DELETE or TRUNCATE, on any table of the public schema. Sequences and the
  // EXECUTE of a writing definer function are not probed: the grants of the migration of the role are the guarantee there
  canWrite: boolean
  // The server is a standby (pg_is_in_recovery())
  inRecovery: boolean
}

export const REPLICA_ROLE_FACTS_SQL = `
  SELECT
    current_user::text AS "roleName",
    r.rolsuper AS "isSuperuser",
    r.rolbypassrls AS "bypassesRls",
    EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
        AND (has_any_column_privilege(current_user, c.oid, 'INSERT')
          OR has_any_column_privilege(current_user, c.oid, 'UPDATE')
          OR has_table_privilege(current_user, c.oid, 'DELETE')
          OR has_table_privilege(current_user, c.oid, 'TRUNCATE'))
    ) AS "canWrite",
    pg_is_in_recovery() AS "inRecovery"
  FROM pg_roles r
  WHERE r.rolname = current_user
`

// null when the replica handle is safe; otherwise what to tell the person who starts the service
export function replicaRoleProblem(facts: ReplicaRoleFacts): string | null {
  // A superuser or a role that skips row security reads rows the policies hide, even on a standby
  if (facts.isSuperuser || facts.bypassesRls) {
    return `DATABASE_REPLICA_URL connects as ${facts.roleName}, which is a superuser or skips row level security: use platform_replica_ro`
  }
  if (facts.canWrite && !facts.inRecovery) {
    return `DATABASE_REPLICA_URL connects as ${facts.roleName}, which can write, to a server that is not a standby: use platform_replica_ro`
  }
  return null
}
