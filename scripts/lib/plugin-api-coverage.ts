// Everything a person can do through the API must be reachable by a plugin of a third party too (owner,
// 2026-11-12): each route of ApiRoutes names the scope of a plugin that will reach it through
// /api/v1/plugin-api/* (Step 5.6), or says why a plugin never does. The check is on the mapping, not on
// the controllers of the plugin API, which do not exist yet: the routes that are not exposed are frozen
// in scripts/plugin-api-baseline.json, which can only shrink.
import { DEFERRED_STATUS } from './frontend-coverage'

export type PluginApiCoverage =
  // The scope that PluginScopes already declares; a list when the route has methods of both kinds (the
  // read scope for the GET, the write one for the rest); `exposed` is the plugin-api path once it is built
  | { scope: string | readonly string[]; exposed?: string }
  // A list with at least one scope that PluginScopes does not have yet, and the step of the plan that adds it
  | { proposed: string | readonly string[]; step: string; exposed?: string }
  // Only a person does it, and why
  | { none: string }

export interface PluginApiReport {
  unmapped: string[]
  stale: string[]
  // Not exactly one of scope, proposed and none; an unknown or malformed scope; a step the plan does not
  // have or that is deferred; an empty reason; an `exposed` that is not a plugin-api path
  invalid: string[]
}

const SCOPE_VALUE = /^\s{2}[A-Z0-9_]+:\s*'([a-z0-9_-]+:[a-z0-9_-]+)'/gm
const SCOPE_KEY = /^\s{2}[A-Z0-9_]+:/gm
const PROPOSED_SCOPE = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/
const PLUGIN_API_PATH = /^\/plugin-api\/\S+$/
const MAP_KEY = /^\s{2}'([A-Za-z0-9.]+)':/gm

// The values of the `PluginScopes` object of the SDK, read as text (the SDK is not a dependency of the tooling)
export function declaredScopes(source: string): string[] {
  const block = /export const PluginScopes = \{([\s\S]*?)\} as const/.exec(source)?.[1] ?? ''
  const values = [...block.matchAll(SCOPE_VALUE)].map(([, scope]) => scope ?? '')
  // A key whose value was not read (a shape the pattern does not know) must not drop a scope in silence
  if (values.length !== [...block.matchAll(SCOPE_KEY)].length) {
    throw new Error('a scope of PluginScopes could not be read as text: did its format change?')
  }
  return values
}

// The route keys that a copy of the map names, read as text (the one of main, from git)
export function mappedKeys(source: string): string[] {
  return [...source.matchAll(MAP_KEY)].map(([, key]) => key ?? '')
}

function isInvalid(
  entry: unknown,
  scopes: ReadonlySet<string>,
  steps: ReadonlyMap<string, string>
): boolean {
  const record = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<
    string,
    unknown
  >
  const kinds = ['scope', 'proposed', 'none'].filter(kind => record[kind] !== undefined)
  if (kinds.length !== 1) return true
  const { scope, proposed, none, step, exposed } = record
  const allowed =
    kinds[0] === 'scope'
      ? ['scope', 'exposed']
      : kinds[0] === 'proposed'
        ? ['proposed', 'step', 'exposed']
        : ['none']
  if (Object.keys(record).some(key => !allowed.includes(key))) return true
  if (exposed !== undefined && (typeof exposed !== 'string' || !PLUGIN_API_PATH.test(exposed))) {
    return true
  }
  if (kinds[0] === 'none') return typeof none !== 'string' || none.trim() === ''
  const listed = (value: unknown): string[] | undefined => {
    const list = typeof value === 'string' ? [value] : value
    return Array.isArray(list) && list.length > 0 && list.every(item => typeof item === 'string')
      ? list
      : undefined
  }
  if (kinds[0] === 'scope') {
    const list = listed(scope)
    return list === undefined || list.some(item => !scopes.has(item))
  }
  const list = listed(proposed)
  // At least one of them is new (else it is a `scope`); the others may already be declared (a read scope)
  if (
    list === undefined ||
    list.some(item => !PROPOSED_SCOPE.test(item)) ||
    list.every(item => scopes.has(item))
  ) {
    return true
  }
  const status = typeof step === 'string' ? steps.get(step) : undefined
  return status === undefined || DEFERRED_STATUS.test(status)
}

export function checkPluginApiCoverage(
  exposed: readonly string[],
  map: Readonly<Record<string, PluginApiCoverage>>,
  scopes: readonly string[],
  steps: ReadonlyMap<string, string>
): PluginApiReport {
  const known = new Set(exposed)
  const declared = new Set(scopes)
  return {
    unmapped: exposed.filter(key => !Object.hasOwn(map, key)).sort(),
    stale: Object.keys(map)
      .filter(key => !known.has(key))
      .sort(),
    invalid: Object.entries(map)
      .filter(([, entry]) => isInvalid(entry, declared, steps))
      .map(([key]) => key)
      .sort()
  }
}

// What a plugin still cannot reach: a route that has a scope (declared or proposed) and no plugin-api path yet
export function pendingKeys(map: Readonly<Record<string, PluginApiCoverage>>): string[] {
  return Object.entries(map)
    .filter(([, entry]) => !('none' in entry) && entry.exposed === undefined)
    .map(([key]) => key)
    .sort()
}

export interface PluginApiBaseline {
  pending: string[]
}

// The pending list can lose keys (a route got its plugin-api path) and gain only the keys of routes that
// main does not map: a route that is new, whose controller of the plugin API is Step 5.6 (owner)
export function baselineGrowth(
  previous: PluginApiBaseline,
  next: PluginApiBaseline,
  mappedOnMain: readonly string[]
): string[] {
  const before = new Set(previous.pending)
  const onMain = new Set(mappedOnMain)
  return next.pending.filter(key => !before.has(key) && onMain.has(key)).sort()
}

// The routes that are pending today and that the baseline does not list, or that it lists and are exposed now
export function baselineDrift(
  baseline: PluginApiBaseline,
  current: readonly string[]
): { added: string[]; removed: string[] } {
  const listed = new Set(baseline.pending)
  const now = new Set(current)
  return {
    added: current.filter(key => !listed.has(key)).sort(),
    removed: baseline.pending.filter(key => !now.has(key)).sort()
  }
}
