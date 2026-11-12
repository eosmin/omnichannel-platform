// Every route of the API must name the scope through which a plugin reaches it, or say why none does
// (see scripts/lib/plugin-api-coverage.ts). What is not exposed yet is frozen in
// scripts/plugin-api-baseline.json, which can only shrink.
// Usage: tsx scripts/check-plugin-api-coverage.ts [--update-down | --require-main]
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { argv, exit } from 'node:process'

import { ApiRoutes } from '@platform/core/api'

import { flattenKeys } from './lib/frontend-coverage'
import { planSteps } from './lib/isolation'
import {
  type PluginApiBaseline,
  baselineDrift,
  baselineGrowth,
  checkPluginApiCoverage,
  declaredScopes,
  mappedKeys,
  pendingKeys
} from './lib/plugin-api-coverage'
import { PLUGIN_API_COVERAGE } from './plugin-api-coverage-map'

const PLAN = 'docs/IMPLEMENTATION_PLAN.md'
const SCOPES_FILE = 'libs/plugins/sdk/src/plugin-scopes.ts'
const MAP_FILE = 'scripts/plugin-api-coverage-map.ts'
const BASELINE_FILE = 'scripts/plugin-api-baseline.json'

const steps = planSteps(readFileSync(PLAN, 'utf8'))
if (steps.size === 0) {
  console.error(`no step found in the progress table of ${PLAN}: did its format change?`)
  exit(1)
}
const scopes = declaredScopes(readFileSync(SCOPES_FILE, 'utf8'))
if (scopes.length === 0) {
  console.error(`no plugin scope found in ${SCOPES_FILE}: did its format change?`)
  exit(1)
}

const exposed = flattenKeys(ApiRoutes)
const { unmapped, stale, invalid } = checkPluginApiCoverage(
  exposed,
  PLUGIN_API_COVERAGE,
  scopes,
  steps
)
const failures: string[] = []
if (unmapped.length > 0) {
  failures.push(
    `routes with no plugin scope and no reason (map each one in ${MAP_FILE}):\n  ${unmapped.join('\n  ')}`
  )
}
if (stale.length > 0) {
  failures.push(`routes in the map that the API no longer has:\n  ${stale.join('\n  ')}`)
}
if (invalid.length > 0) {
  failures.push(
    `invalid entries (one of scope, proposed or none; a scope PluginScopes declares; a proposed scope it does not, with a step of the plan that is not deferred; a plugin-api path in exposed; a reason that is not empty):\n  ${invalid.join('\n  ')}`
  )
}

const current = pendingKeys(PLUGIN_API_COVERAGE)
const baseline = JSON.parse(readFileSync(BASELINE_FILE, 'utf8')) as PluginApiBaseline

if (argv.includes('--update-down') && failures.length === 0) {
  const { added } = baselineDrift(baseline, current)
  if (added.length > 0) {
    console.error(
      `${added.length} routes are pending and not in the baseline; it is not raised by hand: ${added.join(', ')}`
    )
    exit(1)
  }
  writeFileSync(BASELINE_FILE, `${JSON.stringify({ pending: current }, null, 2)}\n`)
  console.log(`baseline lowered: ${current.length} routes still pending`)
  exit(0)
}

function mainRef(): string | undefined {
  const ref = ['origin/main', 'main'].find(
    candidate => spawnSync('git', ['rev-parse', '--verify', '--quiet', candidate]).status === 0
  )
  const base =
    ref === undefined
      ? undefined
      : spawnSync('git', ['merge-base', ref, 'HEAD'], { encoding: 'utf8' })
  return base !== undefined && base.status === 0 ? base.stdout.trim() : undefined
}

// The baseline cannot be raised to make the check pass: it is compared with main's. A route that main does
// not map is new, and may be pending (its plugin-api controller is Step 5.6); one that main maps may not
const base = mainRef()
if (base === undefined) {
  if (argv.includes('--require-main')) {
    console.error('plugin-api: cannot find main to compare the baseline with (fetch-depth 0?)')
    exit(1)
  }
} else {
  const show = (file: string): string | undefined => {
    const shown = spawnSync('git', ['show', `${base}:${file}`], { encoding: 'utf8' })
    return shown.status === 0 ? shown.stdout : undefined
  }
  const previous = show(BASELINE_FILE)
  const previousMap = show(MAP_FILE)
  // Only the commit that creates both files has nothing to compare with; one of them missing, or a map of
  // main that reads as empty, is a check that could not run, and a pull request must not raise its own limit
  if (previous === undefined && previousMap === undefined) {
    // First introduction
  } else if (
    previous === undefined ||
    previousMap === undefined ||
    mappedKeys(previousMap).length === 0
  ) {
    console.error(
      `plugin-api: ${BASELINE_FILE} or ${MAP_FILE} of main cannot be read, so the baseline cannot be compared`
    )
    exit(1)
  } else {
    for (const key of baselineGrowth(
      JSON.parse(previous) as PluginApiBaseline,
      baseline,
      mappedKeys(previousMap)
    )) {
      failures.push(
        `${BASELINE_FILE}: ${key} is pending on this branch and was not on main; it can only shrink`
      )
    }
  }
}

const { added, removed } = baselineDrift(baseline, current)
for (const key of added) {
  failures.push(
    `${key} has a plugin scope and no plugin-api path, and is not in ${BASELINE_FILE}: add it there if the route is new, or fix the entry`
  )
}
if (removed.length > 0) {
  console.warn(
    `plugin-api: ${removed.length} routes of the baseline are exposed now: pnpm validate:plugin-api --update-down`
  )
}

if (failures.length > 0) {
  console.error('Plugin API coverage (CLAUDE.md, definition of done):')
  for (const failure of failures) console.error(`  ${failure}`)
  exit(1)
}
console.log(
  `plugin-api: ${exposed.length} routes mapped, ${current.length} still to expose (owner Step 5.6)`
)
