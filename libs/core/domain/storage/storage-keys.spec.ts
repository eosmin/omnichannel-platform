import { parseMediaObjectKey, StorageKeys } from './storage-keys'

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
    expect(parseMediaObjectKey(`stores/${STORE}/x/messages/${MEDIA}/a.png`)).toBeNull()
  })
})
