// Every route, realtime event and channel capability that the backend exposes must name the step of the
// plan that gives it an interface, or say why it has none (see scripts/lib/frontend-coverage.ts).
// Usage: tsx scripts/check-frontend-coverage.ts
import { readFileSync } from 'node:fs'
import { exit } from 'node:process'

import { ApiRoutes } from '@platform/core/api'
import { RealtimeEvents } from '@platform/core/realtime'

import { CAPABILITY_COVERAGE, REALTIME_COVERAGE, ROUTE_COVERAGE } from './frontend-coverage-map'
import { checkCoverage, flattenKeys } from './lib/frontend-coverage'
import { planSteps } from './lib/isolation'

const PLAN = 'docs/IMPLEMENTATION_PLAN.md'
// The SDK is not a dependency of the tooling scope: its list of capabilities is read as text
const CAPABILITIES = 'libs/plugins/sdk/src/channel-capability.ts'
const CAPABILITY_KEY = /^\s{2}([A-Z_]+):\s*'/gm
const steps = planSteps(readFileSync(PLAN, 'utf8'))
// No step at all means that the progress table was not read, not that nothing is planned
if (steps.size === 0) {
  console.error(`no step found in the progress table of ${PLAN}: did its format change?`)
  exit(1)
}

// Only the object of the capabilities, so that another constant of the file is not counted
const capabilitiesSource = readFileSync(CAPABILITIES, 'utf8')
const capabilitiesBlock =
  /export const ChannelCapability = \{([\s\S]*?)\} as const/.exec(capabilitiesSource)?.[1] ?? ''
const capabilities = [...capabilitiesBlock.matchAll(CAPABILITY_KEY)].map(([, key]) => key ?? '')
// No capability at all means that the file was not read as expected, not that none exists
if (capabilities.length === 0) {
  console.error(`no channel capability found in ${CAPABILITIES}: did its format change?`)
  exit(1)
}

const KINDS = [
  { plural: 'routes', exposed: flattenKeys(ApiRoutes), map: ROUTE_COVERAGE },
  {
    plural: 'realtime events',
    exposed: Object.keys(RealtimeEvents),
    map: REALTIME_COVERAGE
  },
  {
    plural: 'channel capabilities',
    exposed: capabilities,
    map: CAPABILITY_COVERAGE
  }
]

let failed = false
for (const { plural, exposed, map } of KINDS) {
  const { unmapped, stale, invalid } = checkCoverage(exposed, map, steps)
  if (unmapped.length > 0) {
    failed = true
    console.error(
      `${plural} with no step that draws them (map each one in scripts/frontend-coverage-map.ts, to a step or to a reason):\n  ${unmapped.join('\n  ')}`
    )
  }
  if (stale.length > 0) {
    failed = true
    console.error(`${plural} in the map that the backend no longer has:\n  ${stale.join('\n  ')}`)
  }
  if (invalid.length > 0) {
    failed = true
    console.error(
      `${plural} mapped to a step the plan does not have or that is deferred, to an empty reason, or to more or less than one of step and none:\n  ${invalid.join('\n  ')}`
    )
  }
}
if (failed) exit(1)
console.log(
  `${KINDS.map(({ plural, exposed }) => `${exposed.length} ${plural}`).join(', ')}: all mapped`
)
