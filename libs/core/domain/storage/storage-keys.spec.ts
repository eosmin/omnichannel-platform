import {
  parseAvatarKey,
  parseAvatarUploadKey,
  parseMediaObjectKey,
  StorageKeys
} from './storage-keys'

const STORE = '11111111-1111-4111-8111-111111111111'
const MEDIA = '22222222-2222-4222-8222-222222222222'

describe('parseMediaObjectKey', () => {
  it('reads back the keys the builders make', () => {
    expect(parseMediaObjectKey(StorageKeys.message(STORE, MEDIA, 'a.png'))).toEqual({
      area: 'messages',
      mediaId: MEDIA
    })
    expect(parseMediaObjectKey(StorageKeys.messageVariant(STORE, MEDIA, 'thumb'))).toEqual({
      area: 'messages',
      mediaId: MEDIA
    })
    expect(parseMediaObjectKey(StorageKeys.messageUpload(STORE, MEDIA, 'a.png'))).toEqual({
      area: 'uploads',
      mediaId: MEDIA
    })
  })

  it('knows nothing of any other key', () => {
    expect(parseMediaObjectKey(StorageKeys.export(STORE, MEDIA, 'x.csv'))).toBeNull()
    expect(parseMediaObjectKey(StorageKeys.product(STORE, MEDIA, MEDIA, 'p.png'))).toBeNull()
    expect(parseMediaObjectKey(StorageKeys.avatar(STORE, MEDIA, 'a.png'))).toBeNull()
    expect(parseMediaObjectKey(StorageKeys.avatarUpload(STORE, MEDIA, 'a.png'))).toBeNull()
    expect(parseMediaObjectKey(`stores/${STORE}/x/messages/${MEDIA}/a.png`)).toBeNull()
  })
})

describe('the keys of an avatar', () => {
  const USER = '33333333-3333-4333-8333-333333333333'

  it('sit under the user, and the staging one is read back', () => {
    expect(StorageKeys.avatar(USER, MEDIA, 'a.png')).toBe(`users/${USER}/avatar/${MEDIA}/a.png`)
    expect(StorageKeys.avatarUpload(USER, MEDIA, 'a.png')).toBe(
      `users/${USER}/avatar-uploads/${MEDIA}/a.png`
    )
    expect(StorageKeys.avatar(USER, MEDIA, 'a.png').startsWith(StorageKeys.userPrefix(USER))).toBe(
      true
    )
    expect(parseAvatarUploadKey(StorageKeys.avatarUpload(USER, MEDIA, 'a.png'))).toEqual({
      userId: USER,
      mediaId: MEDIA
    })
  })

  it('reads back the final key of an avatar, and not the staging one', () => {
    expect(parseAvatarKey(StorageKeys.avatar(USER, MEDIA, 'a.png'))).toEqual({
      userId: USER,
      mediaId: MEDIA
    })
    expect(parseAvatarKey(StorageKeys.avatarUpload(USER, MEDIA, 'a.png'))).toBeNull()
  })

  it('never read the final key of an avatar, or a key of a store, as a staging object', () => {
    expect(parseAvatarUploadKey(StorageKeys.avatar(USER, MEDIA, 'a.png'))).toBeNull()
    expect(parseAvatarUploadKey(StorageKeys.messageUpload(STORE, MEDIA, 'a.png'))).toBeNull()
  })

  it('do not let one user prefix cover another user (a shared id start)', () => {
    expect(
      StorageKeys.avatar(`${USER}x`, MEDIA, 'a.png').startsWith(StorageKeys.userPrefix(USER))
    ).toBe(false)
  })
})
