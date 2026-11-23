import { type Permission, ClientPermissions } from '@platform/core/auth'

// Whether the store navigation shows "Settings": the person may open at least one page of the area.
// Kept apart from the list of pages (`store-entries.ts`) because the navigation loads on every screen
// and the list, with its paths, is only needed inside the settings; a spec holds the two in step.
export function mayOpenStoreSettings(can: (permission: Permission) => boolean): boolean {
  return (
    can(ClientPermissions.ORG_MANAGE_STORES) ||
    can(ClientPermissions.SETTINGS_VIEW) ||
    can(ClientPermissions.TEAM_VIEW) ||
    // A role that only manages one of these (an integrator with API keys) still has a page to open
    can(ClientPermissions.SETTINGS_MANAGE_WEBHOOKS) ||
    can(ClientPermissions.SETTINGS_MANAGE_API_KEYS) ||
    can(ClientPermissions.SETTINGS_MANAGE_RETENTION) ||
    // Whoever reviews the requests of people for their data has that one page
    can(ClientPermissions.CUSTOMERS_DSR_REVIEW) ||
    // An auditor holds only the permission to read the audit log
    can(ClientPermissions.ORG_VIEW_AUDIT_LOG)
  )
}
