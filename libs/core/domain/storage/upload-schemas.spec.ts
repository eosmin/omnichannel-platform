import { MediaPurpose } from './media-purpose'
import { AvatarUpload, ProductImageUpload, UploadLimits } from './upload-constants'
import { refuseUpload, UploadRefusals } from './upload-rules'
import { ClientUploadPurposes, confirmUploadSchema, requestUploadUrlSchema } from './upload-schemas'

const request = {
  purpose: MediaPurpose.MESSAGE,
  filename: 'a.png',
  contentType: 'image/png',
  fileSizeBytes: 1024
}

describe('refuseUpload', () => {
  it('accepts an allowed type within its limit', () => {
    expect(
      refuseUpload('image/png', UploadLimits.MAX_FILE_SIZE_BYTES, MediaPurpose.MESSAGE)
    ).toBeNull()
    expect(
      refuseUpload('video/mp4', UploadLimits.MAX_VIDEO_SIZE_BYTES, MediaPurpose.MESSAGE)
    ).toBeNull()
  })

  it('refuses a type that is not allowed, even a small one', () => {
    expect(refuseUpload('application/x-msdownload', 10, MediaPurpose.MESSAGE)).toBe(
      'type_not_allowed'
    )
    expect(refuseUpload('image/svg+xml', 10, MediaPurpose.MESSAGE)).toBe('type_not_allowed')
    expect(refuseUpload('text/html', 10, MediaPurpose.MESSAGE)).toBe('type_not_allowed')
  })

  it('refuses a file over the limit of its kind: 10 MB, 25 MB for video', () => {
    expect(
      refuseUpload('image/png', UploadLimits.MAX_FILE_SIZE_BYTES + 1, MediaPurpose.MESSAGE)
    ).toBe(UploadRefusals.TOO_LARGE)
    expect(
      refuseUpload('video/mp4', UploadLimits.MAX_FILE_SIZE_BYTES + 1, MediaPurpose.MESSAGE)
    ).toBeNull()
    expect(
      refuseUpload('video/mp4', UploadLimits.MAX_VIDEO_SIZE_BYTES + 1, MediaPurpose.MESSAGE)
    ).toBe('too_large')
  })
})

describe('refuseUpload for an avatar', () => {
  it('takes the three still image types within 2 MB', () => {
    for (const type of AvatarUpload.CONTENT_TYPES) {
      expect(refuseUpload(type, AvatarUpload.MAX_SIZE_BYTES, MediaPurpose.AVATAR)).toBeNull()
    }
  })

  it.each(['image/gif', 'video/mp4', 'application/pdf', 'image/svg+xml'])(
    'refuses %s, which a message file may be',
    type => {
      expect(refuseUpload(type, 10, MediaPurpose.AVATAR)).toBe(UploadRefusals.TYPE_NOT_ALLOWED)
    }
  )

  it.each(['Image/PNG', 'IMAGE/JPEG', 'image/png; charset=binary', ' image/png', 'image/png '])(
    'refuses the type "%s": it is compared as the signed url carries it, not cleaned up',
    type => {
      expect(refuseUpload(type, 10, MediaPurpose.AVATAR)).toBe(UploadRefusals.TYPE_NOT_ALLOWED)
    }
  )

  it('is never reached by an empty file: the body schema refuses a size under one byte', () => {
    expect(requestUploadUrlSchema.safeParse({ ...request, fileSizeBytes: 0 }).success).toBe(false)
  })

  it('refuses what a message file would take: over 2 MB', () => {
    expect(refuseUpload('image/png', AvatarUpload.MAX_SIZE_BYTES + 1, MediaPurpose.AVATAR)).toBe(
      UploadRefusals.TOO_LARGE
    )
    expect(
      refuseUpload('image/png', AvatarUpload.MAX_SIZE_BYTES + 1, MediaPurpose.MESSAGE)
    ).toBeNull()
  })
})

describe('refuseUpload for a product', () => {
  it('takes the three still image types within the limit of a product picture', () => {
    for (const type of ProductImageUpload.CONTENT_TYPES) {
      expect(refuseUpload(type, ProductImageUpload.MAX_SIZE_BYTES, MediaPurpose.PRODUCT)).toBeNull()
    }
  })

  it.each(['image/gif', 'video/mp4', 'application/pdf', 'image/svg+xml', 'text/html'])(
    'refuses %s, which a message file may be',
    type => {
      expect(refuseUpload(type, 10, MediaPurpose.PRODUCT)).toBe(UploadRefusals.TYPE_NOT_ALLOWED)
    }
  )

  it('refuses one byte over the limit, and the type is compared as it is signed', () => {
    expect(
      refuseUpload('image/png', ProductImageUpload.MAX_SIZE_BYTES + 1, MediaPurpose.PRODUCT)
    ).toBe(UploadRefusals.TOO_LARGE)
    expect(refuseUpload('Image/PNG', 10, MediaPurpose.PRODUCT)).toBe(
      UploadRefusals.TYPE_NOT_ALLOWED
    )
  })
})

describe('the upload schemas', () => {
  it('accept a request for a purpose a client may upload for', () => {
    expect(requestUploadUrlSchema.parse(request)).toEqual(request)
    expect(ClientUploadPurposes).toEqual([MediaPurpose.MESSAGE, MediaPurpose.PRODUCT])
  })

  it('refuse the avatar as a purpose of a store: it has routes of its own', () => {
    expect(
      requestUploadUrlSchema.safeParse({ ...request, purpose: MediaPurpose.AVATAR }).success
    ).toBe(false)
  })

  it.each([MediaPurpose.EXPORT, MediaPurpose.ORDER, MediaPurpose.SHIPPING_LABEL])(
    'refuse the purpose %s: the server writes it or its step has not built it',
    purpose => {
      expect(requestUploadUrlSchema.safeParse({ ...request, purpose }).success).toBe(false)
    }
  )

  it('refuse fields they do not know: a storeId in the body is not read', () => {
    expect(requestUploadUrlSchema.safeParse({ ...request, storeId: 'x' }).success).toBe(false)
  })

  it('refuse a parentId on a message file: it has no parent', () => {
    expect(
      requestUploadUrlSchema.safeParse({ ...request, parentId: crypto.randomUUID() }).success
    ).toBe(false)
  })

  describe('for a product', () => {
    const product = { ...request, purpose: MediaPurpose.PRODUCT, parentId: crypto.randomUUID() }

    it('need the id of the product, a UUID, on both routes', () => {
      expect(requestUploadUrlSchema.safeParse(product).success).toBe(true)
      expect(requestUploadUrlSchema.safeParse({ ...product, parentId: undefined }).success).toBe(
        false
      )
      expect(requestUploadUrlSchema.safeParse({ ...product, parentId: 'nope' }).success).toBe(false)
      const confirmProduct = {
        ...product,
        mediaId: crypto.randomUUID(),
        key: 'stores/s/uploads/m/a.png'
      }
      expect(confirmUploadSchema.safeParse(confirmProduct).success).toBe(true)
      expect(
        confirmUploadSchema.safeParse({ ...confirmProduct, parentId: undefined }).success
      ).toBe(false)
    })

    it('refuse a storeId beside the parentId', () => {
      expect(requestUploadUrlSchema.safeParse({ ...product, storeId: 'x' }).success).toBe(false)
    })
  })

  it.each([0, -1, 1.5, '10'])('refuse the size %j', fileSizeBytes => {
    expect(requestUploadUrlSchema.safeParse({ ...request, fileSizeBytes }).success).toBe(false)
  })

  it('confirm needs a UUID media id', () => {
    const confirm = { ...request, mediaId: 'not-a-uuid', key: 'stores/s/messages/m/a.png' }
    expect(confirmUploadSchema.safeParse(confirm).success).toBe(false)
    expect(
      confirmUploadSchema.safeParse({ ...confirm, mediaId: crypto.randomUUID() }).success
    ).toBe(true)
  })

  const confirm = {
    ...request,
    mediaId: crypto.randomUUID(),
    key: 'stores/s/uploads/m/a.png'
  }

  it('confirm refuses fields it does not know, a purpose of the server, and a key that is empty or too long', () => {
    expect(confirmUploadSchema.safeParse(confirm).success).toBe(true)
    expect(confirmUploadSchema.safeParse({ ...confirm, storeId: 'x' }).success).toBe(false)
    expect(
      confirmUploadSchema.safeParse({ ...confirm, purpose: MediaPurpose.EXPORT }).success
    ).toBe(false)
    expect(confirmUploadSchema.safeParse({ ...confirm, key: '' }).success).toBe(false)
    expect(confirmUploadSchema.safeParse({ ...confirm, key: 'k'.repeat(1025) }).success).toBe(false)
    expect(confirmUploadSchema.safeParse({ ...confirm, fileSizeBytes: 0 }).success).toBe(false)
  })

  it('refuseUpload takes a file of exactly the limit and refuses one byte more', () => {
    expect(refuseUpload('image/png', UploadLimits.MAX_VIDEO_SIZE_BYTES, MediaPurpose.MESSAGE)).toBe(
      UploadRefusals.TOO_LARGE
    )
    expect(
      refuseUpload('application/pdf', UploadLimits.MAX_FILE_SIZE_BYTES, MediaPurpose.MESSAGE)
    ).toBeNull()
    expect(
      refuseUpload('application/pdf', UploadLimits.MAX_FILE_SIZE_BYTES + 1, MediaPurpose.MESSAGE)
    ).toBe(UploadRefusals.TOO_LARGE)
  })
})
