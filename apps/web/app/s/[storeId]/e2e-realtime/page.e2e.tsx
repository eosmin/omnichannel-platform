import type { ReactElement } from 'react'

import { E2eRealtimeHarness } from '../../e2e-realtime-harness'

// Only compiled when E2E_HARNESS=1 (next.config.ts, pageExtensions): the image has no such route
export default function E2eRealtimePage(): ReactElement {
  return <E2eRealtimeHarness />
}
