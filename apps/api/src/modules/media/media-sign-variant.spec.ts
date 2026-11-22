import { ImageVariants, StorageKeys } from '@platform/core/storage'

import { MediaService } from './media.service'

const STORE = '11111111-1111-4111-8111-111111111111'
const OTHER_STORE = '22222222-2222-4222-8222-222222222222'

function signer() {
  const signed: { key: string }[] = []
  const storage = {
    downloadUrl: (params: { key: string }) => {
      signed.push(params)
      return Promise.resolve(`signed:${params.key}`)
    }
  }
  const sign = (variants: unknown) =>
    MediaService.prototype.signVariant.call(
      { storage },
      STORE,
      'a.png',
      variants,
      ImageVariants.THUMB
    )
  return { sign, signed }
}

const keyOf = (storeId: string, name: string) =>
  `${StorageKeys.storePrefix(storeId)}variants/${name}.webp`

describe('MediaService.signVariant', () => {
  it('signs a variant that lives under the prefix of the store', async () => {
    const { sign, signed } = signer()

    const url = await sign({
      full: keyOf(STORE, 'f'),
      medium: keyOf(STORE, 'm'),
      thumb: keyOf(STORE, 't')
    })

    expect(url).toBe(`signed:${keyOf(STORE, 't')}`)
    expect(signed).toHaveLength(1)
  })

  it('never signs a key under the prefix of another store', async () => {
    const { sign, signed } = signer()

    const url = await sign({
      full: keyOf(OTHER_STORE, 'f'),
      medium: keyOf(OTHER_STORE, 'm'),
      thumb: keyOf(OTHER_STORE, 't')
    })

    expect(url).toBeNull()
    expect(signed).toHaveLength(0)
  })

  it.each([null, undefined, 'x', { thumb: 5 }, {}])('reads %j as no variant', async value => {
    const { sign, signed } = signer()

    expect(await sign(value)).toBeNull()
    expect(signed).toHaveLength(0)
  })
})
