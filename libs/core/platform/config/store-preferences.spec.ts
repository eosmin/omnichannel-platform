import { readStorePreferences, updateStorePreferencesSchema } from './store-preferences'

describe('readStorePreferences', () => {
  it('reads the factory defaults from an empty column', () => {
    expect(readStorePreferences({})).toEqual({ sendReadReceipts: true })
  })

  it('keeps what the store chose', () => {
    expect(readStorePreferences({ sendReadReceipts: false })).toEqual({ sendReadReceipts: false })
  })

  it('keeps a switch the store turned off next to a key it does not know or that does not fit', () => {
    expect(readStorePreferences({ sendReadReceipts: false, other: { nested: 'x' } })).toEqual({
      sendReadReceipts: false
    })
  })

  it.each([null, 'text', 42, { sendReadReceipts: 'no' }])(
    'reads the defaults from a value that does not fit: %j',
    raw => {
      expect(readStorePreferences(raw)).toEqual({ sendReadReceipts: true })
    }
  )
})

describe('updateStorePreferencesSchema', () => {
  it('takes the keys that change', () => {
    expect(updateStorePreferencesSchema.parse({ sendReadReceipts: false })).toEqual({
      sendReadReceipts: false
    })
  })

  it.each([
    ['nothing', {}],
    ['a key it does not know', { sendReadReceipts: true, other: 1 }],
    [
      'a value of another type, which reading would turn into the default',
      { sendReadReceipts: 'no' }
    ],
    ['null', { sendReadReceipts: null }]
  ])('refuses %s', (_name, body) => {
    expect(updateStorePreferencesSchema.safeParse(body).success).toBe(false)
  })
})
