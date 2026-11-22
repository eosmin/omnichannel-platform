import { Permissions } from '@platform/core/auth'

import en from '../../messages/en.json'
import es from '../../messages/es.json'

import {
  ACCOUNT_SETTINGS_ENTRIES,
  SettingsAreas,
  firstVisibleHref,
  ORG_SETTINGS_ENTRIES,
  storeSettingsEntries,
  visibleEntries
} from './entries'
import { mayOpenStoreSettings } from './may-open-settings'

const holding =
  (...held: string[]) =>
  (permission: string) =>
    held.includes(permission)

describe('the transfers entry', () => {
  const idsOf = (...held: string[]): string[] =>
    visibleEntries(ORG_SETTINGS_ENTRIES, holding(...held)).map(entry => entry.id)

  it('opens with either permission of transfers, and with neither it is not listed', () => {
    expect(idsOf(Permissions.INVENTORY_MANAGE_TRANSFERS)).toEqual(['transfers'])
    expect(idsOf(Permissions.INVENTORY_RECEIVE_TRANSFERS)).toEqual(['transfers'])
    expect(idsOf(Permissions.INVENTORY_VIEW)).toEqual(['warehouses'])
  })

  it('is the first page of a person who only receives transfers', () => {
    expect(
      firstVisibleHref(ORG_SETTINGS_ENTRIES, holding(Permissions.INVENTORY_RECEIVE_TRANSFERS))
    ).toBe('/org/transfers')
  })
})

describe('settings entries', () => {
  it('shows an organization admin both organization pages', () => {
    const can = holding(
      Permissions.ORG_MANAGE_STORES,
      Permissions.INVENTORY_VIEW,
      Permissions.SETTINGS_VIEW
    )
    expect(visibleEntries(ORG_SETTINGS_ENTRIES, can).map(entry => entry.id)).toEqual([
      'stores',
      'warehouses',
      'profile'
    ])
  })

  it('keeps the warehouses page from who only manages stores', () => {
    const can = holding(Permissions.ORG_MANAGE_STORES)
    expect(visibleEntries(ORG_SETTINGS_ENTRIES, can).map(entry => entry.id)).toEqual(['stores'])
  })

  it('shows the warehouses page to who may see the inventory, with no other organization page', () => {
    const can = holding(Permissions.INVENTORY_VIEW)
    expect(visibleEntries(ORG_SETTINGS_ENTRIES, can).map(entry => entry.id)).toEqual(['warehouses'])
  })

  it('shows the counts page to who counts and to who only approves, and to nobody else', () => {
    const ids = (...held: string[]) =>
      visibleEntries(ORG_SETTINGS_ENTRIES, holding(...held)).map(entry => entry.id)
    expect(ids(Permissions.INVENTORY_MANAGE_COUNTS)).toEqual(['counts'])
    expect(ids(Permissions.INVENTORY_APPLY_COUNTS)).toEqual(['counts'])
    expect(ids(Permissions.INVENTORY_ADJUST)).toEqual([])
    // /org opens the counts for an approver who holds nothing else of the area
    expect(
      firstVisibleHref(ORG_SETTINGS_ENTRIES, holding(Permissions.INVENTORY_APPLY_COUNTS))
    ).toBe('/org/counts')
  })

  it('hides the stores page from who cannot manage stores, and keeps the profile', () => {
    const can = holding(Permissions.SETTINGS_VIEW)
    expect(visibleEntries(ORG_SETTINGS_ENTRIES, can).map(entry => entry.id)).toEqual(['profile'])
  })

  it('shows nothing of the organization to who holds neither permission', () => {
    expect(visibleEntries(ORG_SETTINGS_ENTRIES, holding())).toEqual([])
    expect(firstVisibleHref(ORG_SETTINGS_ENTRIES, holding())).toBeNull()
  })

  it('always shows the account pages: they need no permission', () => {
    expect(visibleEntries(ACCOUNT_SETTINGS_ENTRIES, holding())).toHaveLength(4)
  })

  it('builds the store pages under the store id and asks for the store permission', () => {
    const entries = storeSettingsEntries('s-1')
    expect(entries[0]?.href).toBe('/s/s-1/settings/general')
    expect(visibleEntries(entries, holding())).toEqual([])
    expect(
      visibleEntries(entries, holding(Permissions.ORG_MANAGE_STORES)).map(entry => entry.id)
    ).toEqual(['general'])
  })

  it('shows Channels, Plugins, Routing, Business hours, Tags, Snippets, Inbox behavior, Inventory, Order messages, Returns and Preferences to who may see settings, and General only to who manages stores', () => {
    const entries = storeSettingsEntries('s-1')
    expect(
      visibleEntries(
        entries,
        holding(Permissions.SETTINGS_VIEW, Permissions.CONVERSATIONS_VIEW, Permissions.ORDERS_VIEW)
      ).map(entry => entry.href)
    ).toEqual([
      '/s/s-1/settings/channels',
      '/s/s-1/settings/plugins',
      '/s/s-1/settings/routing',
      '/s/s-1/settings/business-hours',
      '/s/s-1/settings/tags',
      '/s/s-1/settings/snippets',
      '/s/s-1/settings/inbox',
      '/s/s-1/settings/safety',
      '/s/s-1/settings/inventory',
      '/s/s-1/settings/order-templates',
      '/s/s-1/settings/returns',
      '/s/s-1/settings/preferences'
    ])
  })

  it('shows Safety and confirmations to who holds settings:view and conversations:view, and to nobody with only one', () => {
    const entries = storeSettingsEntries('s-1')
    const hrefsOf = (...held: string[]): string[] =>
      visibleEntries(entries, holding(...held)).map(entry => entry.href)
    expect(hrefsOf(Permissions.SETTINGS_VIEW, Permissions.CONVERSATIONS_VIEW)).toContain(
      '/s/s-1/settings/safety'
    )
    expect(hrefsOf(Permissions.SETTINGS_VIEW)).not.toContain('/s/s-1/settings/safety')
    expect(hrefsOf(Permissions.CONVERSATIONS_VIEW)).not.toContain('/s/s-1/settings/safety')
  })

  it('shows Webhooks, API keys and Data retention each to who holds its own permission, and to nobody else', () => {
    const entries = storeSettingsEntries('s-1')
    const hrefsOf = (...held: string[]): string[] =>
      visibleEntries(entries, holding(...held)).map(entry => entry.href)
    expect(hrefsOf(Permissions.SETTINGS_MANAGE_WEBHOOKS)).toEqual(['/s/s-1/settings/webhooks'])
    expect(hrefsOf(Permissions.SETTINGS_MANAGE_API_KEYS)).toEqual(['/s/s-1/settings/api-keys'])
    expect(hrefsOf(Permissions.SETTINGS_MANAGE_RETENTION)).toEqual(['/s/s-1/settings/retention'])
    // settings:view opens none of the three: they act on credentials and on deleting data
    const viewer = hrefsOf(Permissions.SETTINGS_VIEW)
    expect(viewer).not.toContain('/s/s-1/settings/webhooks')
    expect(viewer).not.toContain('/s/s-1/settings/api-keys')
    expect(viewer).not.toContain('/s/s-1/settings/retention')
  })

  it('shows the Audit log to who holds org:view_audit_log, and to nobody else', () => {
    const entries = storeSettingsEntries('s-1')
    const hrefsOf = (...held: string[]): string[] =>
      visibleEntries(entries, holding(...held)).map(entry => entry.href)
    expect(hrefsOf(Permissions.ORG_VIEW_AUDIT_LOG)).toEqual(['/s/s-1/settings/audit-log'])
    // Neither the settings nor the retention of data open it: reading who did what is its own right
    expect(hrefsOf(Permissions.SETTINGS_VIEW)).not.toContain('/s/s-1/settings/audit-log')
    expect(hrefsOf(Permissions.SETTINGS_MANAGE_RETENTION)).not.toContain(
      '/s/s-1/settings/audit-log'
    )
  })

  it('hides Order messages from who may see settings but not orders', () => {
    const hrefs = visibleEntries(
      storeSettingsEntries('s-1'),
      holding(Permissions.SETTINGS_VIEW)
    ).map(entry => entry.href)
    expect(hrefs).not.toContain('/s/s-1/settings/order-templates')
    expect(hrefs).toContain('/s/s-1/settings/returns')
    expect(hrefs).toContain('/s/s-1/settings/preferences')
  })

  it('hides Tags and Snippets from who may see settings but not conversations', () => {
    const entries = storeSettingsEntries('s-1')
    const hrefs = visibleEntries(entries, holding(Permissions.SETTINGS_VIEW)).map(
      entry => entry.href
    )
    expect(hrefs).not.toContain('/s/s-1/settings/tags')
    expect(hrefs).not.toContain('/s/s-1/settings/snippets')
  })

  it('shows Team to who may view the team, whatever else they hold', () => {
    const entries = storeSettingsEntries('s-1')
    expect(
      visibleEntries(entries, holding(Permissions.TEAM_VIEW)).map(entry => entry.href)
    ).toEqual(['/s/s-1/settings/team'])
  })

  it('shows the Settings entry of the navigation exactly when a page of the area is visible', () => {
    const entries = storeSettingsEntries('s-1')
    for (const held of [
      [],
      [Permissions.ORG_MANAGE_STORES],
      [Permissions.SETTINGS_VIEW],
      [Permissions.ORG_MANAGE_STORES, Permissions.SETTINGS_VIEW],
      [Permissions.SETTINGS_EDIT],
      [Permissions.TEAM_VIEW]
    ]) {
      const can = holding(...held)
      expect(mayOpenStoreSettings(can)).toBe(visibleEntries(entries, can).length > 0)
    }
  })

  it('opens an area on the first page the person may see', () => {
    expect(firstVisibleHref(ORG_SETTINGS_ENTRIES, holding(Permissions.SETTINGS_VIEW))).toBe(
      '/org/profile'
    )
  })
})

describe('settings navigation texts', () => {
  const areas = [
    [SettingsAreas.STORE, storeSettingsEntries('s')],
    [SettingsAreas.ORG, ORG_SETTINGS_ENTRIES],
    [SettingsAreas.ACCOUNT, ACCOUNT_SETTINGS_ENTRIES]
  ] as const

  it.each([
    ['en', en],
    ['es', es]
  ])('has a label for every entry of every area in %s', (_name, messages) => {
    for (const [area, entries] of areas) {
      const texts = messages.settings.nav[area] as Record<string, string>
      expect(texts.label).toEqual(expect.any(String))
      expect(texts.title).toEqual(expect.any(String))
      for (const entry of entries) expect(texts[entry.labelKey]).toEqual(expect.any(String))
    }
  })
})
