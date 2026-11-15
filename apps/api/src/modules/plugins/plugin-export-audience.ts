import type { Permission } from '@platform/core/auth'

import { pluginUserId } from '../tenancy/actor'

import { permissionsOfScopes } from './plugin-install-rules'

// Who reads the exports of a plugin and what it may still read. The owner of an export row is `plugin:<installation id>` (never the id of
// a person), and the kinds it sees are those the permissions of ALL its scopes cover, as a person sees the kinds their role still allows:
// a plugin that lost `exports:write` stops seeing the files it asked for, as a member who lost the permission does.
export function pluginExportAudience(installation: { id: string; scopes: readonly string[] }): {
  userId: string
  held: readonly Permission[]
} {
  return { userId: pluginUserId(installation.id), held: permissionsOfScopes(installation.scopes) }
}
