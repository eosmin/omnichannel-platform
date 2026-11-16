import { Permissions } from '@platform/core/auth'

import { assertMayAgreeFees, mayViewCarrierFees, withFeesFor } from './carrier-fees-access'

const view = { id: 'c-1', commissionBps: 450, serviceRatesCents: { CCE: 300 } }

describe('the carrier fees access', () => {
  it('shows the fees only to who holds finance:view_carrier_fees, and not to who only sees shipping', () => {
    expect(mayViewCarrierFees([Permissions.SHIPPING_VIEW])).toBe(false)
    expect(mayViewCarrierFees([Permissions.FINANCE_VIEW_CARRIER_FEES])).toBe(true)
    expect(withFeesFor(view, [Permissions.SHIPPING_VIEW])).toEqual({
      id: 'c-1',
      commissionBps: null,
      serviceRatesCents: {}
    })
    expect(withFeesFor(view, [Permissions.FINANCE_VIEW_CARRIER_FEES])).toBe(view)
  })

  it('refuses to agree the fees without the permission, and lets a body that names none through', () => {
    expect(() =>
      assertMayAgreeFees({ commissionBps: 100 }, [Permissions.SETTINGS_MANAGE_CARRIERS])
    ).toThrow(/view carrier fees/)
    expect(() =>
      assertMayAgreeFees({ serviceRatesCents: {} }, [Permissions.SETTINGS_MANAGE_CARRIERS])
    ).toThrow()
    expect(() =>
      assertMayAgreeFees({ commissionBps: null }, [Permissions.SETTINGS_MANAGE_CARRIERS])
    ).toThrow()
    expect(() => assertMayAgreeFees({}, [Permissions.SETTINGS_MANAGE_CARRIERS])).not.toThrow()
    expect(() =>
      assertMayAgreeFees({ commissionBps: 100 }, [Permissions.FINANCE_VIEW_CARRIER_FEES])
    ).not.toThrow()
  })
})
