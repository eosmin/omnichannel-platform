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

describe('settings entries', () => {
  it('shows an organization admin both organization pages', () => {
    const can = holding(Permissions.ORG_MANAGE_STORES, Permissions.SETTINGS_VIEW)
    expect(visibleEntries(ORG_SETTINGS_ENTRIES, can).map(entry => entry.id)).toEqual([
      'stores',
      'profile'
    ])
  })

  it('shows the counts page to who counts and to who only approves, and to nobody else', () => {
    const ids = (...held: string[]) =>
      visibleEntries(ORG_SETTINGS_ENTRIES, holding(...held)).map(entry => entry.id)
    expect(ids(Permissions.INVENTORY_MANAGE_COUNTS)).toEqual(['counts'])
    expect(ids(Permissions.INVENTORY_APPLY_COUNTS)).toEqual(['counts'])
    expect(ids(Permissions.INVENTORY_VIEW, Permissions.INVENTORY_ADJUST)).toEqual([])
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

  it('shows Channels, Plugins, Routing, Business hours, Tags, Snippets, Inbox behavior and Inventory to who may see settings, and General only to who manages stores', () => {
    const entries = storeSettingsEntries('s-1')
    expect(
      visibleEntries(
        entries,
        holding(Permissions.SETTINGS_VIEW, Permissions.CONVERSATIONS_VIEW)
      ).map(entry => entry.href)
    ).toEqual([
      '/s/s-1/settings/channels',
      '/s/s-1/settings/plugins',
      '/s/s-1/settings/routing',
      '/s/s-1/settings/business-hours',
      '/s/s-1/settings/tags',
      '/s/s-1/settings/snippets',
      '/s/s-1/settings/inbox',
      '/s/s-1/settings/inventory'
    ])
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
