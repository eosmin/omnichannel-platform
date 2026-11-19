import type { OwnerClient } from '@platform/core/database-testing'

// A spec that fills or empties thousands of rows leaves work for the autovacuum, which wakes within seconds, in the middle of the next
// spec of the process. The plan specs (rls-*-plan) take ACCESS EXCLUSIVE locks with ALTER TABLE ... ROW LEVEL SECURITY on those same
// tables, and Postgres aborted one of the two with 40P01 in two runs of main (the autovacuum of customers). VACUUM (ANALYZE) does at once
// what the autovacuum would do, so there is nothing left for it. The order in which Jest runs the specs of a process is not fixed, so
// every spec that seeds or empties the tables of a plan spec calls this itself, instead of relying on whoever runs before.
// #784 (retry on 40P01) stays: it absorbs the isolated deadlock, this removes its usual cause.
export async function quietTables(owner: OwnerClient, tables: readonly string[]): Promise<void> {
  // Sequential and outside a transaction (VACUUM cannot run inside one), the biggest tables first by the order the caller gives
  for (const table of tables) {
    await owner.$executeRawUnsafe(`VACUUM (ANALYZE) ${table}`)
  }
}

// The tables the plan specs seed and lock
export const PLAN_SPEC_TABLES = ['messages', 'conversations', 'customer_identities', 'customers']
