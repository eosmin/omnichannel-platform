// PostgreSQL's SQLSTATE for "canceling statement due to lock timeout" (lock_not_available)
const LOCK_NOT_AVAILABLE = '55P03'
// PostgreSQL's SQLSTATE for "insufficient_privilege": what a row-level security policy answers (WITH CHECK or USING) when it refuses a row
const INSUFFICIENT_PRIVILEGE = '42501'
const MAX_DEPTH = 6
// The places an error keeps the error that caused it, walked by both checks below
const CAUSE_KEYS = ['cause', 'meta', 'driverAdapterError'] as const
// Prisma's code for a transaction that could not start in time (no connection of the pool free within `maxWait`) or that ran past its
// `timeout`: the database rolled it back and nothing was written
const TRANSACTION_API_ERROR = 'P2028'

// How long a request of the api waits for a lock before the database gives up (PostgreSQL
// `lock_timeout`). Under the 15 s limit of a tenant transaction (prisma.service.ts), so the caller gets
// DATABASE_BUSY and not an expired transaction. It is set on the role `platform_app` by the migration
// 20261113120000_api_lock_timeout, whose literal a test keeps equal to `SQL`; the answer tells the client
// to come back after the same time.
export const ApiLockTimeout = { MS: 5_000, SQL: '5s', RETRY_AFTER_SECONDS: 5 } as const

// Whether a database error is the server giving up on a lock after `lock_timeout`. The error reaches
// the code in more than one shape: from the driver as `{ code }`, and from Prisma as P2010 with the
// driver error in `meta.driverAdapterError.cause.originalCode`. Looked for by walking the places the
// code is kept, to a fixed depth so a cycle cannot loop. The message is NOT read: it can carry text a
// user typed (a name, a note), and a match on it would turn an unrelated failure into a retryable 503
// that is never reported.
export function isLockTimeoutError(error: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH || typeof error !== 'object' || error === null) return false
  const record = error as Record<string, unknown>
  if (record['code'] === LOCK_NOT_AVAILABLE || record['originalCode'] === LOCK_NOT_AVAILABLE) {
    return true
  }
  return CAUSE_KEYS.some(key => isLockTimeoutError(record[key], depth + 1))
}

// Whether Prisma gave up on a transaction because it waited too long for a connection or ran over its time (P2028). A burst of writes that
// queue on one lock of the books (the settings row of the finance ledger) holds a connection each until the pool runs out; the ones that
// wait past `maxWait` fail with this code. It is the same busy answer as a lock timeout: nothing was written, so the caller can come back
// (HC-021). Looked for in the same places and to the same depth, and the message is not read.
export function isTransactionWaitError(error: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH || typeof error !== 'object' || error === null) return false
  const record = error as Record<string, unknown>
  if (record['code'] === TRANSACTION_API_ERROR) return true
  return CAUSE_KEYS.some(key => isTransactionWaitError(record[key], depth + 1))
}

// Whether a database error is the refusal of a row-level security policy (SQLSTATE 42501). Found in the same places and to the same
// depth as the checks above, and the message is NOT read. It says only that a policy refused the statement: whether the row it was
// meant for is still there is for the caller to look up, in a new unit of work (the refusal leaves the transaction aborted).
export function isRowLevelSecurityError(error: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH || typeof error !== 'object' || error === null) return false
  const record = error as Record<string, unknown>
  if (
    record['code'] === INSUFFICIENT_PRIVILEGE ||
    record['originalCode'] === INSUFFICIENT_PRIVILEGE
  ) {
    return true
  }
  return CAUSE_KEYS.some(key => isRowLevelSecurityError(record[key], depth + 1))
}
