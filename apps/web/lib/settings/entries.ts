import { AppPaths } from '@platform/api-client'
import { type Permission, ClientPermissions } from '@platform/core/auth'

import { type SettingsEntry, visibleEntries } from './store-entries'

// The store pages live in their own module so that the store navigation, which every screen of the
// store loads, does not carry the organization and account lists with it
export { type SettingsEntry, storeSettingsEntries, visibleEntries } from './store-entries'

export const SettingsAreas = { STORE: 'store', ORG: 'org', ACCOUNT: 'account' } as const
export type SettingsArea = (typeof SettingsAreas)[keyof typeof SettingsAreas]

export const ORG_SETTINGS_ENTRIES: readonly SettingsEntry[] = [
  {
    id: 'stores',
    labelKey: 'stores',
    href: AppPaths.org.stores,
    permission: ClientPermissions.ORG_MANAGE_STORES
  },
  {
    id: 'profile',
    labelKey: 'profile',
    href: AppPaths.org.profile,
    permission: ClientPermissions.SETTINGS_VIEW
  }
]

export const ACCOUNT_SETTINGS_ENTRIES: readonly SettingsEntry[] = [
  { id: 'profile', labelKey: 'profile', href: AppPaths.account.profile, permission: null },
  {
    id: 'preferences',
    labelKey: 'preferences',
    href: AppPaths.account.preferences,
    permission: null
  },
  {
    id: 'notifications',
    labelKey: 'notifications',
    href: AppPaths.account.notifications,
    permission: null
  },
  { id: 'security', labelKey: 'security', href: AppPaths.account.security, permission: null }
]

// The page to open when the area itself is opened ("/org", "/s/x/settings"): the first one the
// person may see, or null when there is none
export function firstVisibleHref(
  entries: readonly SettingsEntry[],
  can: (permission: Permission) => boolean
): string | null {
  return visibleEntries(entries, can)[0]?.href ?? null
}
