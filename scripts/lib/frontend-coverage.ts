// Everything the backend exposes to a browser (a route, a realtime event, a channel capability) must
// say which step of the plan draws or uses it, or why it has no interface. The check is on the
// mapping, not on the code of the web app: that a step really covers what it is mapped to is what
// the audit of the plan and the "Done when" of each step are for.
export type FrontendCoverage =
  // The step of the plan whose tasks build the interface for it
  | { step: string }
  // Nothing in a browser uses it, and why
  | { none: string }

export interface CoverageReport {
  // Exposed by the backend and absent from the map
  unmapped: string[]
  // In the map and no longer exposed
  stale: string[]
  // Mapped to a step the plan does not have or that is deferred, to a reason that is empty, or to both
  invalid: string[]
}

// { auth: { me: '/auth/me' }, returns: { reception: { scan: fn } } }  ->  ['auth.me', 'returns.reception.scan']
export function flattenKeys(tree: Readonly<Record<string, unknown>>, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([key, value]) => {
    const path = prefix === '' ? key : `${prefix}.${key}`
    // A group is a plain object; a path, a path builder or a list of them is one route
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? flattenKeys(value as Record<string, unknown>, path)
      : [path]
  })
}

// A step that is deferred will not draw anything in the MVP: what depends on it has no interface
const DEFERRED_STATUS = /^deferred/i

// An entry is exactly one of a step that exists and is not deferred, or a reason
function isInvalid(entry: unknown, steps: ReadonlyMap<string, string>): boolean {
  // One key, and it is `step` or `none`: a typo or an extra key is a mistake, not a second reason
  const keys = Object.keys(entry ?? {})
  if (keys.length !== 1) return true
  const { step, none } = entry as { step?: unknown; none?: unknown }
  if ((step === undefined) === (none === undefined)) return true
  if (step !== undefined) {
    const status = typeof step === 'string' ? steps.get(step) : undefined
    return status === undefined || DEFERRED_STATUS.test(status)
  }
  return typeof none !== 'string' || none.trim() === ''
}

export function checkCoverage(
  exposed: readonly string[],
  map: Readonly<Record<string, FrontendCoverage>>,
  steps: ReadonlyMap<string, string>
): CoverageReport {
  const known = new Set(exposed)
  const unmapped = exposed.filter(key => !Object.hasOwn(map, key))
  const stale = Object.keys(map).filter(key => !known.has(key))
  const invalid = Object.entries(map)
    .filter(([, entry]) => isInvalid(entry, steps))
    .map(([key]) => key)
  return { unmapped: unmapped.sort(), stale: stale.sort(), invalid: invalid.sort() }
}
