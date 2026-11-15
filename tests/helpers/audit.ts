import type { OwnerClient } from '@platform/core/database-testing'

type AuditFind = OwnerClient['auditLog']['findMany']
type AuditWhere = NonNullable<Parameters<AuditFind>[0]>['where']

const ATTEMPTS = 50
const POLL_MS = 100

// The audit entry is written after the answer (fire-and-forget): wait for it instead of reading
// the table right away. Returns what is there once `expected` entries exist, or after the wait.
// The rows come oldest first, ties broken by id: a table read with no ORDER BY comes back in the
// physical order of Postgres, which changes with the plan and with updated rows, so a test that
// takes the first one must not depend on it.
const OLDEST_FIRST: { timestamp?: 'asc'; id?: 'asc' }[] = [{ timestamp: 'asc' }, { id: 'asc' }]
export async function waitForAuditEntries(
  owner: OwnerClient,
  where: AuditWhere,
  expected = 1
): Promise<Awaited<ReturnType<AuditFind>>> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const entries = await owner.auditLog.findMany({ where, orderBy: OLDEST_FIRST })
    if (entries.length >= expected) return entries
    await new Promise(resolve => setTimeout(resolve, POLL_MS))
  }
  return owner.auditLog.findMany({ where, orderBy: OLDEST_FIRST })
}
