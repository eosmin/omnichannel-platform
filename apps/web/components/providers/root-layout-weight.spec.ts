import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// The providers of the root layout are in the first load of every page, the login included, and the Lighthouse ceilings are measured on that
// load. What only the pages of a store need must not come in through them (Step 7.4 lowers the ceilings as the bundle is split).
const read = (file: string): string => readFileSync(resolve(__dirname, file), 'utf8')

describe('the providers of the root layout', () => {
  it.each(['time-zone-provider.tsx', 'app-providers.tsx'])(
    '%s does not import the hooks of the inbox or the store context',
    file => {
      const source = read(file)
      expect(source).not.toMatch(/from '[^']*lib\/inbox\//)
      expect(source).not.toMatch(/from '\.\/store-context'/)
    }
  )

  it('keeps the zone of a store in a module that only the pages of a store import', () => {
    expect(read('store-time-zone.tsx')).toContain('QueryKeys.inboxBehavior.store(storeId)')
    expect(read('../../app/s/store-shell.tsx')).toContain('providers/store-time-zone')
  })
})
