import { loadVisitorId } from './visitor'

const ID = '123e4567-e89b-42d3-a456-426614174000'

function memory(initial: Record<string, string> = {}): Pick<Storage, 'getItem' | 'setItem'> & {
  data: Record<string, string>
} {
  const data = { ...initial }
  return {
    data,
    getItem: key => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value
    }
  }
}

describe('loadVisitorId', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'crypto', {
      value: { randomUUID: () => ID },
      configurable: true
    })
  })

  it('makes an id once and keeps it for the next visit', () => {
    const storage = memory()

    expect(loadVisitorId(storage)).toBe(ID)
    expect(Object.values(storage.data)).toEqual([ID])
  })

  it('returns the id that was kept', () => {
    const kept = '00000000-0000-4000-8000-000000000001'

    expect(loadVisitorId(memory({ 'platform-widget-visitor': kept }))).toBe(kept)
  })

  it('does not trust a stored value that is not an id', () => {
    expect(loadVisitorId(memory({ 'platform-widget-visitor': 'junk' }))).toBe(ID)
  })

  it('still works when the browser refuses its storage', () => {
    const refusing = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      }
    }

    expect(loadVisitorId(refusing)).toBe(ID)
    expect(loadVisitorId(null)).toBe(ID)
  })
})
