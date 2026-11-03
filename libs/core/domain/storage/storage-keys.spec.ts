import {
  parseAvatarKey,
  parseAvatarUploadKey,
  parseMediaObjectKey,
  StorageKeys
} from './storage-keys'

const STORE = '11111111-1111-4111-8111-111111111111'
const MEDIA = '22222222-2222-4222-8222-222222222222'

describe('parseMediaObjectKey with path steps', () => {
  it.each([
    ['a store that goes up', `stores/../messages/${MEDIA}/a.png`],
    ['a store that stays', `stores/./uploads/${MEDIA}/a.png`],
    ['a media that goes up', `stores/${STORE}/messages/../a.png`],
    ['a media that stays', `stores/${STORE}/uploads/./a.png`]
  ])('reads nothing from %s', (_case, key) => {
    expect(parseMediaObjectKey(key)).toBeNull()
  })
})

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

  it('puts the re-encoded picture under the media id of the upload, and reads it back', () => {
    const key = StorageKeys.avatarImage(USER, MEDIA)
    expect(key).toBe(`users/${USER}/avatar/${MEDIA}/processed/avatar.webp`)
    expect(key.startsWith(StorageKeys.userPrefix(USER))).toBe(true)
    expect(parseAvatarKey(key)).toEqual({ userId: USER, mediaId: MEDIA })
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

  // Review backlog of PR A1 (Step 3.6): what a key that is not one of ours must never become
  describe.each([
    ['parseAvatarKey', parseAvatarKey, 'avatar'],
    ['parseAvatarUploadKey', parseAvatarUploadKey, 'avatar-uploads']
  ])('%s with keys that are not ours', (_name, parse, folder) => {
    it.each([
      ['an empty key', ''],
      ['no file name', `users/${USER}/${folder}/${MEDIA}/`],
      ['no media segment', `users/${USER}/${folder}//a.png`],
      ['no user segment', `users//${folder}/${MEDIA}/a.png`],
      ['a leading slash', `/users/${USER}/${folder}/${MEDIA}/a.png`],
      ['another root', `stores/${USER}/${folder}/${MEDIA}/a.png`],
      ['a root that only ends like ours', `xusers/${USER}/${folder}/${MEDIA}/a.png`],
      ['an extra folder before the user', `x/users/${USER}/${folder}/${MEDIA}/a.png`],
      ['another folder name', `users/${USER}/${folder}x/${MEDIA}/a.png`],
      ['a user segment that goes up', `users/../${folder}/${MEDIA}/a.png`],
      ['a user segment that stays', `users/./${folder}/${MEDIA}/a.png`],
      ['a media segment that goes up', `users/${USER}/${folder}/../a.png`],
      ['a media segment that stays', `users/${USER}/${folder}/./a.png`]
    ])('reads nothing from %s', (_case, key) => {
      expect(parse(key)).toBeNull()
    })

    it('keeps the user of the key, never one that a later segment names', () => {
      expect(parse(`users/${USER}/${folder}/${MEDIA}/users/other/${folder}/m/a.png`)).toEqual({
        userId: USER,
        mediaId: MEDIA
      })
    })
  })
})
