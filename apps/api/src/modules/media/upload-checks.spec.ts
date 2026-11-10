import { Permissions } from '@platform/core/auth'
import { ErrorCodes } from '@platform/core/errors'
import { MediaPurpose } from '@platform/core/storage'

import { refuseUnlessMayUpload } from './upload-checks'

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
})
