import { type Permission, Permissions } from '@platform/core/auth'
import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'

// What the owner agreed with a carrier (its commission, the cost of its guides and how it charges them) is a finance matter: it is read, and agreed, with
// `finance:view_carrier_fees`, not with the permission to see shipping (Step 4B.6b-2, closes (c3)(i) of Step 4.15). A caller without it
// gets the connection with no commission and no rates, and cannot change them.
export const mayViewCarrierFees = (permissions: readonly Permission[]): boolean =>
  permissions.includes(Permissions.FINANCE_VIEW_CARRIER_FEES)

export function withFeesFor<
  T extends { commissionBps: number | null; serviceRatesCents: Record<string, number> }
>(view: T, permissions: readonly Permission[]): T {
  return mayViewCarrierFees(permissions)
    ? view
    : { ...view, commissionBps: null, serviceRatesCents: {} }
}

// A body that names the commission or the rates is the caller agreeing them: it needs the same permission, so nobody changes what
// they cannot see
export function assertMayAgreeFees(
  body: {
    commissionBps?: number | null | undefined
    serviceRatesCents?: unknown
    chargeModel?: string | undefined
  },
  permissions: readonly Permission[]
): void {
  // The charge model decides whether the cost of a guide is owed or already paid: it moves money in the books, so it is agreed with the fees
  const touches =
    body.commissionBps !== undefined ||
    body.serviceRatesCents !== undefined ||
    body.chargeModel !== undefined
  if (touches && !mayViewCarrierFees(permissions)) {
    throw new PlatformException(
      ErrorCodes.PERMISSION_DENIED,
      'agreeing the commission and the rates of a carrier needs the permission to view carrier fees',
      HttpStatusCodes.FORBIDDEN
    )
  }
}
