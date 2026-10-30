import type { OwnerClient } from '@platform/core/database-testing'

type AuditFind = OwnerClient['auditLog']['findMany']
type AuditWhere = NonNullable<Parameters<AuditFind>[0]>['where']

const ATTEMPTS = 50
const POLL_MS = 100

// The audit entry is written after the answer (fire-and-forget): wait for it instead of reading
// the table right away. Returns what is there once `expected` entries exist, or after the wait.
export async function waitForAuditEntries(
  owner: OwnerClient,
  where: AuditWhere,
  expected = 1
): Promise<Awaited<ReturnType<AuditFind>>> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const entries = await owner.auditLog.findMany({ where })
    if (entries.length >= expected) return entries
    await new Promise(resolve => setTimeout(resolve, POLL_MS))
  }
  return owner.auditLog.findMany({ where })
}
