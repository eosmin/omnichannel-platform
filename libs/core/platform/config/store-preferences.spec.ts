import { readStorePreferences } from './store-preferences'

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
