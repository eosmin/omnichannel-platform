// The plan specs run DDL (ALTER TABLE ... ROW LEVEL SECURITY, CREATE POLICY, ALTER FUNCTION ... OWNER) inside a transaction they always
// roll back, over tables that the specs before them in the same process have just filled with thousands of rows. The autovacuum of such
// a table can hold a lock the DDL needs while waiting for one the transaction already holds, and Postgres aborts one of the two with
// 40P01 (deadlock detected). The transaction is rolled back anyway and leaves nothing behind (DDL is transactional), so doing it again
// is safe; the second try finds the vacuum finished or not yet started. Only this error is retried, a few times: any other failure,
// and a deadlock that persists, still fail the spec, and no assertion or threshold of the plan changes.
export const DEADLOCK_DETECTED = '40P01'
export const DEADLOCK_TRIES = 3

const isDeadlock = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { code?: unknown }).code === DEADLOCK_DETECTED

export async function retryOnDeadlock<T>(
  attempt: () => Promise<T>,
  tries: number = DEADLOCK_TRIES
): Promise<T> {
  for (let done = 1; ; done += 1) {
    try {
      return await attempt()
    } catch (error) {
      if (!isDeadlock(error) || done >= tries) throw error
    }
  }
}
