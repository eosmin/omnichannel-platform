import { type Permission, Permissions } from '../auth/permissions'

import { type ExportType, ExportTypes } from './export-constants'

// What each kind of export needs. A kind with no entry is not served yet (the audit log: Step 7.2), so nobody sees its rows, downloads its file or is
// told it is ready. Every permission listed, the same ones the route that makes the kind asks for.
export const ExportTypePermissions: Partial<Record<ExportType, readonly Permission[]>> = {
  [ExportTypes.CONVERSATIONS]: [Permissions.CONVERSATIONS_VIEW, Permissions.CONVERSATIONS_EXPORT],
  [ExportTypes.CUSTOMERS]: [Permissions.CUSTOMERS_EXPORT],
  // Reading the orders (the rows hold the contact data of the customer) and the export itself
  [ExportTypes.ORDERS]: [Permissions.ORDERS_VIEW, Permissions.ORDERS_EXPORT],
  // The figures of the dashboard and the right to take them out of the platform
  [ExportTypes.ANALYTICS]: [Permissions.ANALYTICS_VIEW, Permissions.ANALYTICS_EXPORT],
  [ExportTypes.MEDIA_ZIP]: [
    Permissions.CUSTOMERS_VIEW,
    Permissions.MEDIA_VIEW,
    Permissions.MEDIA_DOWNLOAD_ALL
  ]
}
