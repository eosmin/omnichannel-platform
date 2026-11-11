import { AppPaths, StoreSettingsSections } from '@platform/api-client'
import { type Permission, ClientPermissions } from '@platform/core/auth'

// One page of a settings area (TDD_09 §13). `permission` is what the api asks for the page's own
// read; null is a page of the person's own account, which needs none. The list holds only pages that
// exist: each later step adds its entry together with its page.
export interface SettingsEntry {
  id: string
  // The key under settings.nav.<area>
  labelKey: string
  href: string
  permission: Permission | null
  // A second permission the page needs to read its own data, when the api asks one the entry does not
  also?: Permission
  // A page that opens with either of two permissions (the transfers: making them or receiving them)
  orPermission?: Permission
}

export function storeSettingsEntries(storeId: string): SettingsEntry[] {
  return [
    {
      id: StoreSettingsSections.GENERAL,
      labelKey: 'general',
      href: AppPaths.store.settings(storeId, StoreSettingsSections.GENERAL),
      // The page reads and writes the store through organizations.storeById
      permission: ClientPermissions.ORG_MANAGE_STORES
    },
    {
      id: StoreSettingsSections.CHANNELS,
      labelKey: 'channels',
      href: AppPaths.store.settings(storeId, StoreSettingsSections.CHANNELS),
      permission: ClientPermissions.SETTINGS_VIEW
    },
    {
      id: StoreSettingsSections.PLUGINS,
      labelKey: 'plugins',
      href: AppPaths.store.settings(storeId, StoreSettingsSections.PLUGINS),
      permission: ClientPermissions.SETTINGS_VIEW
    },
    {
      id: StoreSettingsSections.TEAM,
      labelKey: 'team',
      href: AppPaths.store.settings(storeId, StoreSettingsSections.TEAM),
      permission: ClientPermissions.TEAM_VIEW
    },
    {
      id: StoreSettingsSections.ROUTING,
      labelKey: 'routing',
      href: AppPaths.store.settings(storeId, StoreSettingsSections.ROUTING),
      permission: ClientPermissions.SETTINGS_VIEW
    },
    {
      id: StoreSettingsSections.BUSINESS_HOURS,
      labelKey: 'businessHours',
      href: AppPaths.store.settings(storeId, StoreSettingsSections.BUSINESS_HOURS),
      permission: ClientPermissions.SETTINGS_VIEW
    },
    {
      id: StoreSettingsSections.TAGS,
      labelKey: 'tags',
      href: AppPaths.store.settings(storeId, StoreSettingsSections.TAGS),
      permission: ClientPermissions.SETTINGS_VIEW,
      // The api lists them for who may see conversations
      also: ClientPermissions.CONVERSATIONS_VIEW
    },
    {
      id: StoreSettingsSections.SNIPPETS,
      labelKey: 'snippets',
      href: AppPaths.store.settings(storeId, StoreSettingsSections.SNIPPETS),
      permission: ClientPermissions.SETTINGS_VIEW,
      // The api lists them for who may see conversations
      also: ClientPermissions.CONVERSATIONS_VIEW
    },
    {
      id: StoreSettingsSections.INBOX,
      labelKey: 'inbox',
      href: AppPaths.store.settings(storeId, StoreSettingsSections.INBOX),
      permission: ClientPermissions.SETTINGS_VIEW
    },
    {
      id: StoreSettingsSections.INVENTORY,
      labelKey: 'inventory',
      href: AppPaths.store.settings(storeId, StoreSettingsSections.INVENTORY),
      permission: ClientPermissions.SETTINGS_VIEW
    }
  ]
}

// What the person may open. The api still decides every request: this only spares them a link that
// ends in a refusal.
export function visibleEntries(
  entries: readonly SettingsEntry[],
  can: (permission: Permission) => boolean
): SettingsEntry[] {
  return entries.filter(
    entry =>
      (entry.permission === null ||
        can(entry.permission) ||
        (entry.orPermission !== undefined && can(entry.orPermission))) &&
      (entry.also === undefined || can(entry.also))
  )
}
