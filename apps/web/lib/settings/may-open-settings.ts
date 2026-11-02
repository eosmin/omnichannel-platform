import { type Permission, Permissions } from '@platform/core/auth'

// Whether the store navigation shows "Settings": the person may open at least one page of the area.
// Kept apart from the list of pages (`store-entries.ts`) because the navigation loads on every screen
// and the list, with its paths, is only needed inside the settings; a spec holds the two in step.
export function mayOpenStoreSettings(can: (permission: Permission) => boolean): boolean {
  return can(Permissions.ORG_MANAGE_STORES) || can(Permissions.SETTINGS_VIEW)
}
