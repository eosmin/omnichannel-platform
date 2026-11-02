import { MediaPurpose } from './media-purpose'
import { UploadLimits } from './upload-constants'
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
    expect(refuseUpload('image/png', UploadLimits.MAX_FILE_SIZE_BYTES)).toBeNull()
    expect(refuseUpload('video/mp4', UploadLimits.MAX_VIDEO_SIZE_BYTES)).toBeNull()
  })

  it('refuses a type that is not allowed, even a small one', () => {
    expect(refuseUpload('application/x-msdownload', 10)).toBe('type_not_allowed')
    expect(refuseUpload('image/svg+xml', 10)).toBe('type_not_allowed')
    expect(refuseUpload('text/html', 10)).toBe('type_not_allowed')
  })

  it('refuses a file over the limit of its kind: 10 MB, 25 MB for video', () => {
    expect(refuseUpload('image/png', UploadLimits.MAX_FILE_SIZE_BYTES + 1)).toBe(
      UploadRefusals.TOO_LARGE
    )
    expect(refuseUpload('video/mp4', UploadLimits.MAX_FILE_SIZE_BYTES + 1)).toBeNull()
    expect(refuseUpload('video/mp4', UploadLimits.MAX_VIDEO_SIZE_BYTES + 1)).toBe('too_large')
  })
})

describe('the upload schemas', () => {
  it('accept a request for a purpose a client may upload for', () => {
    expect(requestUploadUrlSchema.parse(request)).toEqual(request)
    expect(ClientUploadPurposes).toEqual([MediaPurpose.MESSAGE])
  })

  it.each([
    MediaPurpose.EXPORT,
    MediaPurpose.PRODUCT,
    MediaPurpose.ORDER,
    MediaPurpose.AVATAR,
    MediaPurpose.SHIPPING_LABEL
  ])('refuse the purpose %s: the server writes it or its step has not built it', purpose => {
    expect(requestUploadUrlSchema.safeParse({ ...request, purpose }).success).toBe(false)
  })

  it('refuse fields they do not know: a storeId or a parentId in the body is not read', () => {
    expect(requestUploadUrlSchema.safeParse({ ...request, storeId: 'x' }).success).toBe(false)
    expect(requestUploadUrlSchema.safeParse({ ...request, parentId: 'x' }).success).toBe(false)
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
    expect(refuseUpload('image/png', UploadLimits.MAX_VIDEO_SIZE_BYTES)).toBe(
      UploadRefusals.TOO_LARGE
    )
    expect(refuseUpload('application/pdf', UploadLimits.MAX_FILE_SIZE_BYTES)).toBeNull()
    expect(refuseUpload('application/pdf', UploadLimits.MAX_FILE_SIZE_BYTES + 1)).toBe(
      UploadRefusals.TOO_LARGE
    )
  })
})
