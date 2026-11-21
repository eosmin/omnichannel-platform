import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { type Permission, ClientPermissions, RoleNames, RolePresets } from '@platform/core/auth'

import { AuxiliaryReads, isAwaiting, mayRead } from './auxiliary-reads'

// QA 2026-11-20/21 (VERIF-31 WEB-1/2, VERIF-cd WEB-1/2/3): a screen that loads for a role also read data that the role cannot see, and
// the console filled with 403s. A read made BESIDE the screen's own is made only with the permission its route asks for.
const canOf =
  (granted: readonly string[]) =>
  (permission: Permission): boolean =>
    granted.includes(permission)

// The roles of the two QA piles: the Viewer preset, an accountant (finance and nothing of the inbox) and the customers-only persona
const roles: [string, readonly string[], { directory: boolean; preferences: boolean }][] = [
  [
    'Viewer',
    RolePresets[RoleNames.VIEWER],
    // It sees conversations, so it reads the directories; it has no settings:view, so it must not ask for the preferences
    { directory: true, preferences: false }
  ],
  [
    'accountant',
    [ClientPermissions.REMITTANCES_VIEW, ClientPermissions.ORDERS_VIEW],
    { directory: false, preferences: false }
  ],
  [
    'customers only (p-cus)',
    [ClientPermissions.CUSTOMERS_VIEW],
    { directory: false, preferences: false }
  ],
  ['Admin', RolePresets[RoleNames.ADMIN], { directory: true, preferences: true }]
]

describe('the reads a screen makes beside its own', () => {
  it.each(roles)('%s reads only what its permissions allow', (_name, granted, expected) => {
    const can = canOf(granted)
    expect(mayRead(can, AuxiliaryReads.INBOX_DIRECTORY)).toBe(expected.directory)
    expect(mayRead(can, AuxiliaryReads.STORE_PREFERENCES)).toBe(expected.preferences)
  })

  // The hooks and the screens that make those reads ask `mayRead`; a new read that forgets it would bring the 403 back
  const source = (file: string): string => readFileSync(join(__dirname, file), 'utf8')

  it('asks nothing of nobody when the list of permissions is empty: the read is refused', () => {
    expect(mayRead(canOf([ClientPermissions.CONVERSATIONS_VIEW]), [])).toBe(false)
  })

  it('waits only for a read that is on its way', () => {
    expect(isAwaiting({ isPending: true, fetchStatus: 'fetching' })).toBe(true)
    expect(isAwaiting({ isPending: true, fetchStatus: 'paused' })).toBe(true)
    // Not made (no permission): pending with no data, but nobody is coming with it
    expect(isAwaiting({ isPending: true, fetchStatus: 'idle' })).toBe(false)
    expect(isAwaiting({ isPending: false, fetchStatus: 'fetching' })).toBe(false)
  })

  // The four directory hooks of the inbox run for real in `inbox/use-inbox-data.spec.ts` (renderHook): they make no request without
  // the permission. The screens below stay held by their text: none waits on `isPending` of one of those reads
  it.each([
    ['components/inbox/composer.tsx', 'members'],
    ['components/inbox/bulk-pick-dialog.tsx', 'members'],
    ['components/inbox/bulk-pick-dialog.tsx', 'tags'],
    ['components/settings/routing-rule-dialog.tsx', 'channels'],
    ['components/analytics/dashboard-panels.tsx', 'members'],
    ['app/s/inbox-frame.tsx', 'channels']
  ])(
    '%s does not wait on %s.isPending, which a role without the permission never leaves',
    (file, name) => {
      expect(source(`../${file}`)).not.toContain(`${name}.isPending`)
    }
  )

  it('the overdue threshold of the remittances is read only with settings:view', () => {
    const panel = source('../components/remittances/pending-panel.tsx')
    expect(panel).toContain('mayRead(can, AuxiliaryReads.STORE_PREFERENCES)')
  })
})
