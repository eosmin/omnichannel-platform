import { Permissions } from '@platform/core/auth'
import { ErrorCodes } from '@platform/core/errors'
import { MediaPurpose } from '@platform/core/storage'

import { refuseUnlessMayRead, refuseUnlessMayUpload } from './upload-checks'

describe('refuseUnlessMayUpload', () => {
  it('lets a message file through with no permission besides the one of the route', () => {
    expect(() => refuseUnlessMayUpload(MediaPurpose.MESSAGE, [])).not.toThrow()
  })

  it('asks for PRODUCTS_EDIT to attach a picture to a product', () => {
    let refused: unknown
    try {
      refuseUnlessMayUpload(MediaPurpose.PRODUCT, [Permissions.MEDIA_UPLOAD])
    } catch (error) {
      refused = error
    }
    expect(refused).toMatchObject({ code: ErrorCodes.PERMISSION_DENIED })
    expect(() =>
      refuseUnlessMayUpload(MediaPurpose.PRODUCT, [
        Permissions.PRODUCTS_VIEW,
        Permissions.PRODUCTS_CREATE
      ])
    ).toThrow()
    expect(() =>
      refuseUnlessMayUpload(MediaPurpose.PRODUCT, [Permissions.PRODUCTS_EDIT])
    ).not.toThrow()
  })

  it('asks for ORDERS_VIEW and ORDERS_EDIT or ORDERS_CHANGE_STATUS to attach a file to an order', () => {
    let refused: unknown
    try {
      refuseUnlessMayUpload(MediaPurpose.ORDER, [Permissions.MEDIA_UPLOAD, Permissions.ORDERS_VIEW])
    } catch (error) {
      refused = error
    }
    expect(refused).toMatchObject({
      code: ErrorCodes.PERMISSION_DENIED,
      metadata: { required: [Permissions.ORDERS_EDIT, Permissions.ORDERS_CHANGE_STATUS] }
    })
    expect(() =>
      refuseUnlessMayUpload(MediaPurpose.ORDER, [Permissions.ORDERS_VIEW, Permissions.ORDERS_EDIT])
    ).not.toThrow()
    expect(() =>
      refuseUnlessMayUpload(MediaPurpose.ORDER, [
        Permissions.ORDERS_VIEW,
        Permissions.ORDERS_CHANGE_STATUS
      ])
    ).not.toThrow()
    // Without ORDERS_VIEW the answer for an order id would tell more than reading the order does
    expect(() => refuseUnlessMayUpload(MediaPurpose.ORDER, [Permissions.ORDERS_EDIT])).toThrow()
  })

  it('asks for the journal and one of the two permissions that register a transaction to attach a receipt', () => {
    let refused: unknown
    try {
      refuseUnlessMayUpload(MediaPurpose.FINANCE_DOCUMENT, [
        Permissions.MEDIA_UPLOAD,
        Permissions.FINANCE_VIEW_JOURNAL
      ])
    } catch (error) {
      refused = error
    }
    expect(refused).toMatchObject({
      code: ErrorCodes.PERMISSION_DENIED,
      metadata: {
        required: [Permissions.FINANCE_MANAGE_TRANSACTIONS, Permissions.FINANCE_MOVE_MONEY]
      }
    })
    for (const registering of [
      Permissions.FINANCE_MANAGE_TRANSACTIONS,
      Permissions.FINANCE_MOVE_MONEY
    ]) {
      expect(() =>
        refuseUnlessMayUpload(MediaPurpose.FINANCE_DOCUMENT, [
          Permissions.FINANCE_VIEW_JOURNAL,
          registering
        ])
      ).not.toThrow()
      // Without the journal the answer for a transaction id would tell more than reading it does
      expect(() => refuseUnlessMayUpload(MediaPurpose.FINANCE_DOCUMENT, [registering])).toThrow()
    }
    // Reconciling, viewing the balances or managing the chart does not register a transaction
    expect(() =>
      refuseUnlessMayUpload(MediaPurpose.FINANCE_DOCUMENT, [
        Permissions.FINANCE_VIEW_JOURNAL,
        Permissions.FINANCE_RECONCILE,
        Permissions.FINANCE_MANAGE_ACCOUNTS
      ])
    ).toThrow()
  })
})

describe('refuseUnlessMayRead', () => {
  it('lets anyone through for a purpose with no reading rule', () => {
    expect(() => refuseUnlessMayRead(MediaPurpose.MESSAGE, [])).not.toThrow()
    expect(() => refuseUnlessMayRead(MediaPurpose.PRODUCT, null)).not.toThrow()
  })

  it('asks for ORDERS_VIEW to read a file of an order, and never serves it to a non-member', () => {
    for (const held of [[], [Permissions.MEDIA_VIEW], null]) {
      let refused: unknown
      try {
        refuseUnlessMayRead(MediaPurpose.ORDER, held)
      } catch (error) {
        refused = error
      }
      expect(refused).toMatchObject({ code: ErrorCodes.PERMISSION_DENIED })
    }
    expect(() =>
      refuseUnlessMayRead(MediaPurpose.ORDER, [Permissions.MEDIA_VIEW, Permissions.ORDERS_VIEW])
    ).not.toThrow()
  })

  it.each([MediaPurpose.ORIGIN, MediaPurpose.AVATAR, MediaPurpose.EXPORT])(
    'keeps reading %s with the permission of the route alone',
    purpose => {
      expect(() => refuseUnlessMayRead(purpose, [])).not.toThrow()
    }
  )

  it.each([MediaPurpose.SHIPPING_LABEL, MediaPurpose.BULK_LABELS])(
    'asks for SHIPPING_MANAGE to read %s (name, address and phone of customers), and never serves it to a non-member',
    purpose => {
      for (const held of [[], [Permissions.MEDIA_VIEW, Permissions.SHIPPING_VIEW], null]) {
        let refused: unknown
        try {
          refuseUnlessMayRead(purpose, held)
        } catch (error) {
          refused = error
        }
        expect(refused).toMatchObject({ code: ErrorCodes.PERMISSION_DENIED })
      }
      expect(() => refuseUnlessMayRead(purpose, [Permissions.SHIPPING_MANAGE])).not.toThrow()
    }
  )

  it('asks for REMITTANCES_VIEW to read a settlement file, and never serves it to a non-member', () => {
    for (const held of [[], [Permissions.MEDIA_VIEW], null]) {
      expect(() => refuseUnlessMayRead(MediaPurpose.REMITTANCE_FILE, held)).toThrow()
    }
    expect(() =>
      refuseUnlessMayRead(MediaPurpose.REMITTANCE_FILE, [
        Permissions.MEDIA_VIEW,
        Permissions.REMITTANCES_VIEW
      ])
    ).not.toThrow()
  })

  it('asks for FINANCE_VIEW_JOURNAL to read a receipt, and never serves it to a non-member', () => {
    for (const held of [[], [Permissions.MEDIA_VIEW, Permissions.FINANCE_VIEW], null]) {
      expect(() => refuseUnlessMayRead(MediaPurpose.FINANCE_DOCUMENT, held)).toThrow()
    }
    expect(() =>
      refuseUnlessMayRead(MediaPurpose.FINANCE_DOCUMENT, [
        Permissions.MEDIA_VIEW,
        Permissions.FINANCE_VIEW_JOURNAL
      ])
    ).not.toThrow()
  })

  it('refuses a purpose the table does not know instead of serving it', () => {
    expect(() => refuseUnlessMayRead('something_new', [Permissions.MEDIA_VIEW])).toThrow()
    expect(() => refuseUnlessMayRead('toString', null)).toThrow()
  })
})
