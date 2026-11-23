import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// `area.ts` is read by the navigation of every store screen (`store-nav.tsx`, `store-landing.ts`). Whatever it imports is loaded with the
// orders page and the rest, so it may not pull the settings entries (the organization, account and finance lists) or the finance domain:
// that cost the orders page 6 KB of script and its Lighthouse budget. The family code lives in `family.ts`, for the finance shell only.
describe('finance/area.ts', () => {
  const source = readFileSync(join(__dirname, 'area.ts'), 'utf8')
  const imports = [...source.matchAll(/^import [^;]*?from '([^']+)'/gm)].map(match => match[1])

  it('imports nothing but the permissions', () => {
    expect(imports).toEqual(['@platform/core/auth'])
  })
})
