import { type Permission, Permissions } from '../auth/permissions'

import { type ExportType, ExportTypes } from './export-constants'

// What each kind of export needs. A kind with no entry is not served, so nobody sees its rows, downloads its file or is
// told it is ready. Every permission listed, the same ones the route that makes the kind asks for.
export const ExportTypePermissions: Partial<Record<ExportType, readonly Permission[]>> = {
  [ExportTypes.CONVERSATIONS]: [Permissions.CONVERSATIONS_VIEW, Permissions.CONVERSATIONS_EXPORT],
  [ExportTypes.CUSTOMERS]: [Permissions.CUSTOMERS_EXPORT],
  // Reading the orders (the rows hold the contact data of the customer) and the export itself
  [ExportTypes.ORDERS]: [Permissions.ORDERS_VIEW, Permissions.ORDERS_EXPORT],
  // The figures of the dashboard and the right to take them out of the platform
  [ExportTypes.ANALYTICS]: [Permissions.ANALYTICS_VIEW, Permissions.ANALYTICS_EXPORT],
  // Reading the audit log of the store and taking it out of the platform are one right (TDD_05 §9.3)
  [ExportTypes.AUDIT_LOG]: [Permissions.ORG_VIEW_AUDIT_LOG],
  [ExportTypes.MEDIA_ZIP]: [
    Permissions.CUSTOMERS_VIEW,
    Permissions.MEDIA_VIEW,
    Permissions.MEDIA_DOWNLOAD_ALL
  ]
}
