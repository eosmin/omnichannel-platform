import { type Permission, Permissions } from './auth/permissions'

// The members told when the packing note changes on an order that is already confirmed: whoever may move an order to PREPARING or
// SHIPPED by hand, and whoever makes its guide. Server only: it lives apart from `order-constants.ts` so that the web, which reads that
// file, does not carry the table of permissions with it.
export const PackingNoteNoticePermissions: readonly Permission[] = [
  Permissions.ORDERS_CHANGE_STATUS,
  Permissions.SHIPPING_MANAGE
]
