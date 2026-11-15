import { type Permission, Permissions } from '@platform/core/auth'
import {
  lockStoreForWrite,
  type PrismaService,
  type PrismaTransaction
} from '@platform/core/database'
import {
  type ActorIdentity,
  ActorKinds,
  ConversationAssignedFilters,
  ConversationHiddenStatuses,
  ConversationStatus,
  PLUGIN_ACTOR_PREFIX
} from '@platform/core/domain'
import {
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  resourceNotFound
} from '@platform/core/errors'
import type { ConversationVisibility } from '@platform/core/events'

import type { ConversationFilter } from './conversations.schemas'

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
  // Set when the caller is a plugin (the route took it from the installation of the key): what it writes as the author of a change
  // is this plugin and never `userId`, which is not a row of `users` then
  pluginId?: string
}

export function viewerOf(userId: string, held: readonly Permission[]): Viewer {
  return { userId, held, canViewAll: held.includes(Permissions.CONVERSATIONS_VIEW_ALL) }
}

// Who a change made by this viewer is written under (`actorColumnsOf`): the plugin when the viewer is one, the person otherwise. A
// viewer that is neither (no user id, or the `plugin:` id of a call made for a plugin that did not say which) cannot write a change:
// naming it would put an empty or false author on the row, so it is refused here, loudly, as a bug of the caller.
export function actorOfViewer(viewer: Viewer): ActorIdentity {
  if (viewer.pluginId !== undefined) return { kind: ActorKinds.PLUGIN, pluginId: viewer.pluginId }
  if (viewer.userId === '' || viewer.userId.startsWith(PLUGIN_ACTOR_PREFIX)) {
    throw new PlatformException(
      ErrorCodes.INTERNAL_ERROR,
      'a viewer with no person and no plugin cannot be the author of a change',
      HttpStatusCodes.INTERNAL_SERVER_ERROR
    )
  }
  return { kind: ActorKinds.PERSON, userId: viewer.userId }
}

// What a plugin does to a message it did not write is refused whatever it holds (TDD_10 §6, M1c): `MESSAGES_DELETE` lets a person
// of the team delete the reply of another, a plugin only what is its own. A message is a plugin's own when it names that plugin as its
// author (`authorPluginId`), even when it was written on behalf of a person. A person's call is not touched.
export function isOwnToPlugin(message: { authorPluginId: string | null }, viewer: Viewer): boolean {
  return viewer.pluginId !== undefined && message.authorPluginId === viewer.pluginId
}

export function requireOwnIfPlugin(
  message: { authorPluginId: string | null },
  viewer: Viewer
): void {
  if (viewer.pluginId !== undefined && !isOwnToPlugin(message, viewer)) {
    throw new PlatformException(
      ErrorCodes.PERMISSION_DENIED,
      'the caller may not change this message',
      HttpStatusCodes.FORBIDDEN
    )
  }
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
  snoozedUntil: Date | null
  resolvedAt: Date | null
  snoozeNote: string | null
  attentionReason: string | null
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
  const rows = await tx.$queryRaw<
    {
      status: string
      assigned_to: string | null
      snoozed_until: Date | null
      resolved_at: Date | null
      snooze_note: string | null
      attention_reason: string | null
    }[]
  >`
    SELECT status, assigned_to, snoozed_until, resolved_at, snooze_note, attention_reason FROM conversations
    WHERE id = ${conversationId} AND store_id = ${storeId}
    FOR UPDATE`
  const row = rows[0]
  if (row === undefined || !canSee(viewer, { assignedTo: row.assigned_to, status: row.status })) {
    throw resourceNotFound('conversation')
  }
  return {
    status: row.status,
    assignedTo: row.assigned_to,
    snoozedUntil: row.snoozed_until,
    resolvedAt: row.resolved_at,
    snoozeNote: row.snooze_note,
    attentionReason: row.attention_reason
  }
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

// Archived and spam: out of the inbox, read only by who may archive
export function isHiddenStatus(text: string): boolean {
  return ConversationHiddenStatuses.some(hidden => String(hidden) === text)
}

// Who may see a conversation, from the row as it stands: it travels with the events that tell of it
export function visibilityOf(row: {
  status: string
  assignedTo: string | null
}): ConversationVisibility {
  return { hidden: isHiddenStatus(row.status), assignedTo: row.assignedTo }
}

export function assignedFilter(
  assigned: ConversationFilter['assigned'],
  viewer: Viewer
): { assignedTo?: string | null } {
  if (assigned === undefined) return {}
  if (assigned === ConversationAssignedFilters.UNASSIGNED) return { assignedTo: null }
  return { assignedTo: assigned === ConversationAssignedFilters.ME ? viewer.userId : assigned }
}

// What the list and a bulk action by filter both select, so that "select all 43 matching" acts on
// the set the agent saw: the store, the status (the open ones when none is named), the channel and
// the tag. The visibility and the assignee are added by each caller.
export interface ConversationFilterWhere {
  storeId: string
  status: string | { notIn: string[] }
  channelType?: string
  tags?: { some: { id: string } }
}

export function conversationFilterWhere(
  storeId: string,
  filter: ConversationFilter,
  viewer: Viewer
): ConversationFilterWhere {
  // The history of what was archived or marked as spam is for who may archive
  if (filter.status !== undefined && isHiddenStatus(filter.status)) {
    requireAnyPermission(viewer.held, [Permissions.CONVERSATIONS_ARCHIVE])
  }
  return {
    storeId,
    status: filter.status ?? { notIn: [...ConversationHiddenStatuses] },
    ...(filter.channelType === undefined ? {} : { channelType: filter.channelType }),
    ...(filter.tagId === undefined ? {} : { tags: { some: { id: filter.tagId } } })
  }
}
