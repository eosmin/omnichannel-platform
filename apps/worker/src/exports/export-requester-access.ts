// rls-context: every database access of this file runs inside a JobContext (forStore) opened around that one read
import { type Permission } from '@platform/core/auth'
import type { JobContext, PrismaService } from '@platform/core/database'
import {
  MembershipStatus,
  PLUGIN_ACTOR_PREFIX,
  PluginInstallationStatus,
  PluginStatus
} from '@platform/core/domain'
import { ExportTypePermissions } from '@platform/core/exports'
import { viewPermissionsOf } from '@platform/core/messaging'
import { PluginScopePermissions, PluginScopes } from '@platform/plugins/sdk'

import { isPluginRequester } from './export-requester'

const KNOWN_SCOPES: ReadonlySet<string> = new Set(Object.values(PluginScopes))
const ACTIVE_INSTALLATION: string = PluginInstallationStatus.ACTIVE

// The permissions the requester of an export holds at this moment, read when the file is about to be written, not when it was asked for.
// null: they hold nothing any more (the membership was removed, suspended or revoked; the plugin is no longer installed, active or approved).
// Always filtered by the store of the row, which the worker reads from the row, never from the filters.
export async function currentPermissionsOfRequester(
  prisma: PrismaService,
  jobContext: JobContext,
  storeId: string,
  requestedBy: string
): Promise<readonly Permission[] | null> {
  if (isPluginRequester(requestedBy)) {
    const installation = await jobContext.forStore(storeId, () =>
      prisma.client.pluginInstallation.findFirst({
        where: {
          id: requestedBy.slice(PLUGIN_ACTOR_PREFIX.length),
          storeId,
          status: ACTIVE_INSTALLATION,
          // A plugin the owner withdrew or suspended holds nothing, as at the api guard. Read through the context of the store: a plugin
          // that policy hides from it (another organization's) answers no row, which is a refusal, never more access.
          plugin: { status: PluginStatus.APPROVED }
        },
        select: { scopes: true }
      })
    )
    if (installation === null) return null
    // A row written some other way cannot give a plugin a scope the platform does not declare
    const scopes = [...new Set(installation.scopes)].filter(scope => KNOWN_SCOPES.has(scope))
    return [
      ...new Set(
        scopes.flatMap(
          scope => PluginScopePermissions[scope as keyof typeof PluginScopePermissions]
        )
      )
    ]
  }
  const membership = await jobContext.forStore(storeId, () =>
    prisma.client.membership.findFirst({
      where: { userId: requestedBy, storeId, status: MembershipStatus.ACTIVE, revokedAt: null },
      select: { role: { select: { permissions: { select: { name: true } } } } }
    })
  )
  if (membership === null) return null
  return membership.role.permissions.map(permission => permission.name as Permission)
}

// Whether the kind of file may still be made for who holds `held` now: every permission of the kind, as when it was asked for.
// A kind no permission serves is refused, so that a new kind is never written by default.
export function accessOfRequester(
  type: string,
  held: readonly Permission[] | null
): { allowed: boolean } {
  const needed = ExportTypePermissions[type as keyof typeof ExportTypePermissions]
  if (held === null || held.length === 0 || needed === undefined) return { allowed: false }
  return { allowed: needed.every(permission => held.includes(permission)) }
}

// The viewer a file of conversations or files is written for: what was frozen when it was asked for, cut to what the requester holds now.
// Never more than was asked for, even for a member who was promoted in the gap.
export function narrowedViewer<V extends { userId: string; held: readonly Permission[] }>(
  frozen: V,
  current: readonly Permission[]
): { userId: string; held: Permission[] } {
  return {
    userId: frozen.userId,
    held: viewPermissionsOf(frozen.held).filter(p => current.includes(p))
  }
}

// Whether a file already written may still turn ready: the requester must still hold the kind's permissions and every permission the
// file was made with (the narrowed view of conversations and files). Fails closed: nothing held, or one permission less, is no.
export function fileStillCovered(
  type: string,
  used: readonly Permission[],
  current: readonly Permission[] | null
): boolean {
  if (current === null || !accessOfRequester(type, current).allowed) return false
  return used.every(permission => current.includes(permission))
}
