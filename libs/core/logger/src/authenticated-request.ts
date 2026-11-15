import type { Request } from 'express'

import type { AuthenticatedUser, Permission } from '@platform/core/auth'

// What the guards and middleware write on the request. They write to this type, never to `any`.
// Staff, impersonation and access levels do not exist in the MVP (MVP_TRIM_CHECKLIST.md).
export interface AuthenticatedRequest extends Request {
  correlationId: string
  user?: AuthenticatedUser
  store?: { id: string; organizationId: string; name: string }
  organization?: { id: string }
  membership?: { id: string; roleId: string; roleName: string }
  permissions?: readonly Permission[]
  // Set by PluginApiKeyGuard on a plugin-api route, instead of `user` and `membership`: the call is the installation's
  pluginInstallation?: { id: string; pluginId: string; scopes: readonly string[] }
}
