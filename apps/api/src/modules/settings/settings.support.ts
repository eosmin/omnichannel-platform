import { AuditAction } from '@platform/core/audit'
import type { AuditService } from '@platform/core/audit-module'
import {
  isUniqueViolation,
  lockStoreScope,
  type PrismaService,
  type PrismaTransaction
} from '@platform/core/database'
import {
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  resourceConflict,
  resourceNotFound
} from '@platform/core/errors'

import type { Actor } from '../tenancy'

// Every change of a setting of the store leaves the same entry: who, where, and what it was about
export function auditSettingsChange(
  audit: AuditService,
  storeId: string,
  actor: Actor,
  resourceType: string,
  resourceId: string,
  metadata: Record<string, unknown>
): void {
  audit.log({
    action: AuditAction.SETTINGS_CHANGED,
    actor: { userId: actor.userId },
    storeId,
    resourceType,
    resourceId,
    metadata,
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent
  })
}

// `what` names the resource ("tag"): the message is English and goes to the logs
export function alreadyExists(what: string, field: string): PlatformException {
  return new PlatformException(
    ErrorCodes.RESOURCE_ALREADY_EXISTS,
    `a ${what} with that ${field} already exists`,
    HttpStatusCodes.CONFLICT
  )
}

// The checks of a service answer politely; the unique index of the table is what holds when two
// requests ask for the same value at the same moment
export async function uniqueTransaction<T>(
  prisma: PrismaService,
  taken: PlatformException,
  work: (tx: PrismaTransaction) => Promise<T>
): Promise<T> {
  try {
    return await prisma.transaction(work)
  } catch (error) {
    if (isUniqueViolation(error)) throw taken
    throw error
  }
}

// The lists of the settings are returned whole, so the number of rows is what bounds the answer. The
// count and the insert happen under the lock of the scope, so the limit is exact.
export async function requireRoom(
  tx: PrismaTransaction,
  storeId: string,
  what: 'tag' | 'snippet',
  limit: number
): Promise<void> {
  await lockStoreScope(tx, storeId, what)
  const count =
    what === 'tag'
      ? await tx.tag.count({ where: { storeId } })
      : await tx.snippet.count({ where: { storeId } })
  if (count >= limit) throw resourceConflict(`a store holds at most ${limit} ${what}s`, { limit })
}

// A tag is changed or deleted by one request at a time: the second one finds what the first left.
// A change leaves the key alone, so it takes the lock that lets an agent tag a customer meanwhile
// (that insert holds the tag row FOR KEY SHARE); only the delete excludes it.
export async function lockTag(
  tx: PrismaTransaction,
  storeId: string,
  tagId: string,
  mode: 'change' | 'delete'
): Promise<void> {
  const rows =
    mode === 'change'
      ? await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM tags WHERE id = ${tagId} AND store_id = ${storeId} FOR NO KEY UPDATE`
      : await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM tags WHERE id = ${tagId} AND store_id = ${storeId} FOR UPDATE`
  if (rows.length === 0) throw resourceNotFound('tag')
}

// The closing message and the away message point at a snippet with no foreign key, so these two
// locks are what keeps the pointer and the snippet together. Whoever points at a snippet holds it
// shared until it commits; whoever deletes it holds it exclusive while it counts the pointers. The
// two take turns, and the one that comes second sees what the first committed (READ COMMITTED).
// A snippet of another store is a snippet that does not exist.
export async function lockSnippet(
  tx: PrismaTransaction,
  storeId: string,
  snippetId: string,
  mode: 'reference' | 'write'
): Promise<void> {
  const rows =
    mode === 'reference'
      ? await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM snippets WHERE id = ${snippetId} AND store_id = ${storeId} FOR SHARE`
      : await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM snippets WHERE id = ${snippetId} AND store_id = ${storeId} FOR UPDATE`
  if (rows.length === 0) throw resourceNotFound('snippet')
}
