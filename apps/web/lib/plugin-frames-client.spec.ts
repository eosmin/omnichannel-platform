/**
 * @jest-environment jsdom
 */
import {
  clearReloadMark,
  documentFrameOrigins,
  framesAllowed,
  readFrameCookie,
  shouldReloadFor,
  writeFrameCookie
} from './plugin-frames-client'

const STORE = '0b8f6a52-3d1c-4c8e-9a47-5e2f1d7c9b10'

afterEach(() => {
  document.head.innerHTML = ''
  document.cookie.split('; ').forEach(entry => {
    const name = entry.split('=')[0]
    if (name !== undefined && name !== '') document.cookie = `${name}=; Max-Age=0; Path=/`
  })
})

describe('documentFrameOrigins', () => {
  it('reads what the proxy allowed from the meta tag', () => {
    document.head.innerHTML =
      '<meta name="plugin-frame-origins" content="https://widgets.acme.example https://b.other.example">'
    expect(documentFrameOrigins(document)).toEqual([
      'https://widgets.acme.example',
      'https://b.other.example'
    ])
  })

  it('is empty with no tag or an empty one', () => {
    expect(documentFrameOrigins(document)).toEqual([])
    document.head.innerHTML = '<meta name="plugin-frame-origins" content="">'
    expect(documentFrameOrigins(document)).toEqual([])
  })
})

describe('framesAllowed', () => {
  it('needs every origin to be allowed', () => {
    expect(framesAllowed(['https://a.example'], ['https://a.example'])).toBe(true)
    expect(framesAllowed(['https://a.example'], ['https://a.example', 'https://b.example'])).toBe(
      false
    )
    expect(framesAllowed([], [])).toBe(true)
  })
})

describe('the cookie of a store', () => {
  it('is written and read back', () => {
    writeFrameCookie(document, STORE, ['https://widgets.acme.example'], false)
    expect(readFrameCookie(document, STORE)).toEqual(['https://widgets.acme.example'])
  })

  it('is removed when the store has no widget origins left', () => {
    writeFrameCookie(document, STORE, ['https://widgets.acme.example'], false)
    writeFrameCookie(document, STORE, [], false)
    expect(readFrameCookie(document, STORE)).toEqual([])
  })

  it('is read for its own store only', () => {
    writeFrameCookie(document, STORE, ['https://widgets.acme.example'], false)
    expect(readFrameCookie(document, '9c1d3e44-7a52-4b0f-8e61-2a4b6c8d0e12')).toEqual([])
  })
})

describe('shouldReloadFor', () => {
  const storage = () => {
    const data = new Map<string, string>()
    return {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value)
    }
  }

  it('reloads once for a set of origins, then never again for the same set', () => {
    const mine = storage()
    expect(shouldReloadFor(mine, STORE, ['https://a.example'])).toBe(true)
    expect(shouldReloadFor(mine, STORE, ['https://a.example'])).toBe(false)
  })

  it('reloads again when the set changes, whatever the order it came in', () => {
    const mine = storage()
    shouldReloadFor(mine, STORE, ['https://a.example', 'https://b.example'])
    expect(shouldReloadFor(mine, STORE, ['https://b.example', 'https://a.example'])).toBe(false)
    expect(shouldReloadFor(mine, STORE, ['https://c.example'])).toBe(true)
  })

  it('never reloads when the attempt cannot be remembered', () => {
    expect(shouldReloadFor(null, STORE, ['https://a.example'])).toBe(false)
    const broken = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => undefined
    }
    expect(shouldReloadFor(broken, STORE, ['https://a.example'])).toBe(false)
  })
})

describe('clearReloadMark', () => {
  it('lets a later change of the origins reload again', () => {
    const data = new Map<string, string>()
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key)
    }
    expect(shouldReloadFor(storage, STORE, ['https://a.example'])).toBe(true)
    expect(shouldReloadFor(storage, STORE, ['https://a.example'])).toBe(false)
    clearReloadMark(storage, STORE)
    expect(shouldReloadFor(storage, STORE, ['https://a.example'])).toBe(true)
  })

  it('does nothing without storage', () => {
    expect(() => clearReloadMark(null, STORE)).not.toThrow()
  })
})
