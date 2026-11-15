import { normalizedPluginApiPath } from '@platform/core/api'

import { missingPermissions } from '../tenancy/privilege'

import { isPluginScope, permissionsOfScopes } from './plugin-install-rules'

// What the scan of the controllers learns about one route (apps/api/src/modules/tenancy/route-protection.spec.ts)
export interface PluginApiRouteFacts {
  label: string
  // The path of the route, as the decorators give it; undefined when it is not a plain string
  path: string | undefined
  // The scopes of @PluginApi, or undefined when the route is not marked
  scopes: readonly string[] | undefined
  isPublic: boolean
  // @RequirePermissions: every one is needed
  permissions: readonly string[]
  // @RequireAnyPermission: one is enough
  anyOf: readonly string[]
}

export const PLUGIN_API_PREFIX = '/plugin-api/'

// The rules that keep a plugin from doing more than a human could (TDD_10 §6.2, open point (a) of Step 5.6), for every route a
// plugin can reach. A route under /plugin-api/ must be declared in `PluginApiRoutes`, carry @PluginApi (the one that trades a
// setup code for a key is the exception, because it has no key yet), and every permission it asks of a person must be inside the
// union of the permissions of its scopes: a controller that asked for more than its scopes grant would be refused at every call,
// and one that asked for less would not be checked against what the service does with it. Returns what is wrong, by route.
export function pluginApiRouteViolations(
  routes: readonly PluginApiRouteFacts[],
  declaredPaths: ReadonlySet<string>,
  withoutKey: ReadonlySet<string>
): string[] {
  const violations: string[] = []
  // The paths of the routes are as the decorators spell them (`:id`, `:orderId`), the declared ones with every parameter as ':p'
  const declared = new Set([...declaredPaths].map(normalizedPluginApiPath))
  const keyless = new Set([...withoutKey].map(normalizedPluginApiPath))
  for (const raw of routes) {
    const route = {
      ...raw,
      path: raw.path === undefined ? undefined : normalizedPluginApiPath(raw.path)
    }
    const underPrefix = route.path?.startsWith(PLUGIN_API_PREFIX) === true
    const marked = route.scopes !== undefined
    if (!underPrefix && !marked) continue
    if (underPrefix && route.path !== undefined && !declared.has(route.path)) {
      violations.push(`${route.label}: ${route.path} is not in PluginApiRoutes`)
    }
    if (marked && !underPrefix) {
      violations.push(
        `${route.label}: it is marked @PluginApi and is not under ${PLUGIN_API_PREFIX}`
      )
    }
    if (underPrefix && !marked) {
      if (!route.isPublic || !keyless.has(route.path ?? '')) {
        violations.push(`${route.label}: a route under ${PLUGIN_API_PREFIX} must carry @PluginApi`)
      } else if (route.permissions.length > 0 || route.anyOf.length > 0) {
        violations.push(`${route.label}: a route with no key has no permissions to check`)
      }
      continue
    }
    if (!route.isPublic) {
      violations.push(`${route.label}: @PluginApi routes are public to the global guards`)
    }
    const scopes = route.scopes ?? []
    for (const scope of scopes.filter(scope => !isPluginScope(scope))) {
      violations.push(`${route.label}: ${scope} is not a plugin scope`)
    }
    if (scopes.length > 0 && route.permissions.length === 0 && route.anyOf.length === 0) {
      violations.push(`${route.label}: it names scopes and no @RequirePermissions`)
    }
    const granted = permissionsOfScopes(scopes)
    for (const permission of missingPermissions(granted, route.permissions)) {
      violations.push(`${route.label}: ${permission} is outside what its scopes grant`)
    }
    if (
      route.anyOf.length > 0 &&
      !route.anyOf.some(permission => granted.some(held => held === permission))
    ) {
      violations.push(
        `${route.label}: none of ${route.anyOf.join(', ')} is inside what its scopes grant`
      )
    }
  }
  return violations
}
