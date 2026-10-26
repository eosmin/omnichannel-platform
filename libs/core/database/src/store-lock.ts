import { resourceNotFound } from '@platform/core/errors'

import type { PrismaTransaction } from './prisma.service'

// Every write of data that belongs to a store takes this lock first. Deleting a store takes the
// exclusive lock on the same row, so a delete waits for the writes in flight and a write that comes
// after it finds no store: the cascade of the delete never removes a row it did not look at
// (MVP_TRIM_CHECKLIST.md section 10, item 23).
//
// FOR KEY SHARE and not FOR SHARE: it conflicts with a delete and not with an ordinary update of the
// row, so renaming a store does not wait for the writers, and two writers that both go on to update
// the store cannot deadlock on a lock upgrade.
export async function lockStoreForWrite(tx: PrismaTransaction, storeId: string): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM stores WHERE id = ${storeId} FOR KEY SHARE`
  if (rows.length === 0) throw resourceNotFound('store')
}

// The delete side of the same lock: waits for every writer that holds the shared one. The rows that
// the writers committed are seen by the statements that come after it, because the transaction runs
// at READ COMMITTED (the default of Postgres and of PrismaService): do not raise the level of a
// transaction that calls this. A store that a concurrent delete already removed is not found.
export async function lockStoreForDelete(tx: PrismaTransaction, storeId: string): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM stores WHERE id = ${storeId} FOR UPDATE`
  if (rows.length === 0) throw resourceNotFound('store')
}
