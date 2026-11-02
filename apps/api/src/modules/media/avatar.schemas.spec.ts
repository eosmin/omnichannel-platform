import { confirmAvatarUploadSchema, requestAvatarUploadSchema } from './avatar.schemas'

describe('the avatar upload schemas', () => {
  const body = { filename: 'me.png', contentType: 'image/png', fileSizeBytes: 1024 }

  it('take the file and nothing else: no purpose, store or user is read from the body', () => {
    expect(requestAvatarUploadSchema.parse(body)).toEqual(body)
    for (const extra of [{ purpose: 'avatar' }, { storeId: 'x' }, { userId: 'x' }]) {
      expect(requestAvatarUploadSchema.safeParse({ ...body, ...extra }).success).toBe(false)
    }
  })

  it.each([0, -1, 1.5, '10'])('refuse the size %j', fileSizeBytes => {
    expect(requestAvatarUploadSchema.safeParse({ ...body, fileSizeBytes }).success).toBe(false)
  })

  it('confirm needs a UUID media id, a key, and no extra field', () => {
    const confirm = { ...body, mediaId: crypto.randomUUID(), key: 'users/u/avatar-uploads/m/a.png' }
    expect(confirmAvatarUploadSchema.safeParse(confirm).success).toBe(true)
    expect(confirmAvatarUploadSchema.safeParse({ ...confirm, mediaId: 'x' }).success).toBe(false)
    expect(confirmAvatarUploadSchema.safeParse({ ...confirm, key: '' }).success).toBe(false)
    expect(confirmAvatarUploadSchema.safeParse({ ...confirm, purpose: 'avatar' }).success).toBe(
      false
    )
  })
})
