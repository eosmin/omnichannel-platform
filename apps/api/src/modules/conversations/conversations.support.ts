import { type Permission, Permissions } from '@platform/core/auth'
import {
  lockStoreForWrite,
  type PrismaService,
  type PrismaTransaction
} from '@platform/core/database'
import { ChannelType, ConversationHiddenStatuses, ConversationStatus } from '@platform/core/domain'
import {
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  resourceNotFound
} from '@platform/core/errors'
import type { ConversationVisibility } from '@platform/core/events'

// What the services of the module run their reads on: the transaction of the request when there is
// one, the client otherwise
export type Db = PrismaService['client']

// Who is asking, as far as what they may see: an agent without CONVERSATIONS_VIEW_ALL sees the
// conversations assigned to them and the ones nobody has. Calls with no viewer (the inbound
// pipeline, the schedulers) see everything.
export interface Viewer {
  userId: string
  held: readonly Permission[]
  canViewAll: boolean
}

export function viewerOf(userId: string, held: readonly Permission[]): Viewer {
  return { userId, held, canViewAll: held.includes(Permissions.CONVERSATIONS_VIEW_ALL) }
}

// Who asks for a change of status: a user, whose view and permissions apply, or the system (the
// inbound pipeline, the schedulers), which is named on purpose so that it is never the default
export type ConversationActor = Viewer | 'system'

// A conversation is seen by who may see conversations at all (every route of them asks for it), if it
// is the viewer's or nobody's (or the viewer sees all), and if it is not one of the hidden ones
// (archived, spam) that only who may archive reads
export function canSeeConversation(viewer: Viewer, state: ConversationVisibility): boolean {
  if (!viewer.held.includes(Permissions.CONVERSATIONS_VIEW)) return false
  if (state.hidden && !viewer.held.includes(Permissions.CONVERSATIONS_ARCHIVE)) return false
  return viewer.canViewAll || state.assignedTo === null || state.assignedTo === viewer.userId
}

export function canSee(
  viewer: Viewer | undefined,
  row: { assignedTo: string | null; status: string }
): boolean {
  if (viewer === undefined) return true
  return canSeeConversation(viewer, {
    hidden: isHiddenStatus(row.status),
    assignedTo: row.assignedTo
  })
}

// The same rule as a filter, for the queries that list or count
export function visibleTo(viewer: Viewer | undefined): { OR?: { assignedTo: string | null }[] } {
  if (viewer === undefined || viewer.canViewAll) return {}
  return { OR: [{ assignedTo: null }, { assignedTo: viewer.userId }] }
}

export interface LockedConversation {
  status: string
  assignedTo: string | null
}

// Every write of a conversation starts here, in this order: the shared lock on the store (so that
// deleting the store waits), then the row of the conversation (so that two writes of the same
// conversation, two agents taking it for example, take turns). A conversation of another store, or one
// the viewer may not see, is one that does not exist.
export async function lockConversationForWrite(
  tx: PrismaTransaction,
  storeId: string,
  conversationId: string,
  viewer?: Viewer
): Promise<LockedConversation> {
  await lockStoreForWrite(tx, storeId)
  const rows = await tx.$queryRaw<{ status: string; assigned_to: string | null }[]>`
    SELECT status, assigned_to FROM conversations
    WHERE id = ${conversationId} AND store_id = ${storeId}
    FOR UPDATE`
  const row = rows[0]
  if (row === undefined || !canSee(viewer, { assignedTo: row.assigned_to, status: row.status })) {
    throw resourceNotFound('conversation')
  }
  return { status: row.status, assignedTo: row.assigned_to }
}

// A caller who holds none of the permissions cannot do it: they are named in the answer
export function requireAnyPermission(
  held: readonly Permission[],
  needed: readonly Permission[]
): void {
  if (needed.some(permission => held.includes(permission))) return
  throw new PlatformException(
    ErrorCodes.PERMISSION_DENIED,
    'the caller lacks the permission for this change',
    HttpStatusCodes.FORBIDDEN,
    { permissions: needed }
  )
}

export function invalidInput(message: string): PlatformException {
  return new PlatformException(ErrorCodes.VALIDATION_FAILED, message, HttpStatusCodes.BAD_REQUEST)
}

// A text column that only this api writes, from an enum: anything else is a broken row, and says so
// instead of travelling on as a string
export function enumValueOf<T extends string>(
  values: Record<string, T>,
  text: string,
  what: string
): T {
  const value = Object.values(values).find(candidate => candidate === text)
  if (value === undefined) throw new Error(`${what} with an unknown value: ${text}`)
  return value
}

export const statusOf = (text: string): ConversationStatus =>
  enumValueOf(ConversationStatus, text, 'conversation status')

export const channelOf = (text: string): ChannelType =>
  enumValueOf(ChannelType, text, 'conversation channel')

// Archived and spam: out of the inbox, read only by who may archive
export function isHiddenStatus(text: string): boolean {
  return ConversationHiddenStatuses.some(hidden => String(hidden) === text)
}
