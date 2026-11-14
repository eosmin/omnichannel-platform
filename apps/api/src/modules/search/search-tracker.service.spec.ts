import { createHash } from 'node:crypto'

import type { Queue } from 'bullmq'
import type { PinoLogger } from 'nestjs-pino'

import { SearchTrackedScopes, searchEventDataSchema, SearchTracking } from '@platform/core/domain'
import { JobNames, type TrackAnalyticsJob } from '@platform/core/queues'

import { capUnits, mayKeepText, queryHashOf, SearchTracker } from './search-tracker.service'

const STORE = '11111111-1111-4111-8111-111111111111'

const KEY = 'k'.repeat(32)

describe('the hash of a search text', () => {
  it('is the same for the same text with another case, accents or spacing', () => {
    const hash = queryHashOf(KEY, STORE, 'José  Pérez')
    expect(queryHashOf(KEY, STORE, 'jose perez')).toBe(hash)
    expect(queryHashOf(KEY, STORE, 'JOSÉ PÉREZ ')).toBe(hash)
    expect(hash).toMatch(/^[0-9a-f]{16}$/)
  })

  it('is another for another text, another store or another key', () => {
    const hash = queryHashOf(KEY, STORE, 'jose')
    expect(queryHashOf(KEY, STORE, 'josefa')).not.toBe(hash)
    expect(queryHashOf(KEY, '22222222-2222-4222-8222-222222222222', 'jose')).not.toBe(hash)
    expect(queryHashOf('x'.repeat(32), STORE, 'jose')).not.toBe(hash)
  })

  it('cannot be rebuilt without the key (a plain SHA-256 of a phone number gives another value)', () => {
    const plain = createHash('sha256').update('71234567').digest('hex').slice(0, 16)
    expect(queryHashOf(KEY, STORE, '71234567')).not.toBe(plain)
  })
})

describe('the text kept of a search', () => {
  it('is kept only for a product search that is not about a person', () => {
    expect(mayKeepText(SearchTrackedScopes.PRODUCTS, 'zapato rojo')).toBe(true)
  })

  it('is never kept for people, conversations, orders or the global search, nor for an email or a phone', () => {
    for (const scope of [
      SearchTrackedScopes.CUSTOMERS,
      SearchTrackedScopes.ORDERS,
      SearchTrackedScopes.MESSAGES,
      SearchTrackedScopes.GLOBAL
    ]) {
      expect(mayKeepText(scope, 'zapato rojo')).toBe(false)
    }
    expect(mayKeepText(SearchTrackedScopes.PRODUCTS, 'ana@example.com')).toBe(false)
    expect(mayKeepText(SearchTrackedScopes.PRODUCTS, '+503 7123-4567')).toBe(false)
    // A name or a word with a phone number in it is as personal as the number alone
    expect(mayKeepText(SearchTrackedScopes.PRODUCTS, 'ana 71234567')).toBe(false)
    expect(mayKeepText(SearchTrackedScopes.PRODUCTS, 'tel 7123-4567 urgente')).toBe(false)
    // A size or a year is not
    expect(mayKeepText(SearchTrackedScopes.PRODUCTS, 'talla 42 modelo 2026')).toBe(true)
  })

  it('is cut to the cap in UTF-16 units without splitting a character', () => {
    expect(capUnits('abc')).toBe('abc')
    expect(capUnits('a'.repeat(250))).toHaveLength(200)
    const emoji = '\u{1F600}'.repeat(150)
    const cut = capUnits(emoji)
    expect(cut.length).toBeLessThanOrEqual(200)
    expect([...cut].every(character => character === '\u{1F600}')).toBe(true)
  })
})

describe('the search tracker', () => {
  const add = jest.fn<Promise<unknown>, [string, TrackAnalyticsJob]>()
  const warn = jest.fn()
  const tracker = new SearchTracker({ add } as unknown as Queue<TrackAnalyticsJob>, KEY, {
    setContext: jest.fn(),
    warn
  } as unknown as PinoLogger)

  beforeEach(() => {
    add.mockReset().mockResolvedValue(undefined)
    warn.mockReset()
  })

  it('queues a track-search job whose data fits the schema the worker checks', () => {
    tracker.track(STORE, SearchTrackedScopes.ORDERS, 'pedido 10', 3, performance.now())
    expect(add).toHaveBeenCalledTimes(1)
    const [name, job] = add.mock.calls[0] ?? []
    expect(name).toBe(JobNames.TRACK_SEARCH)
    expect(job?.storeId).toBe(STORE)
    expect(job?.event).toBe('search.performed')
    const data = searchEventDataSchema.parse(job?.data)
    expect(data).toMatchObject({ scope: 'orders', resultCount: 3 })
    // Something was found: the text is not kept
    expect(data.query).toBeUndefined()
  })

  it('keeps the text, capped, when nothing was found about something that is not a person', () => {
    tracker.track(STORE, SearchTrackedScopes.PRODUCTS, 'x'.repeat(250), 0, performance.now())
    const data = searchEventDataSchema.parse(add.mock.calls[0]?.[1].data)
    expect(data.query).toHaveLength(200)
    tracker.track(STORE, SearchTrackedScopes.GLOBAL, 'jose', 0, performance.now())
    expect(searchEventDataSchema.parse(add.mock.calls[1]?.[1].data).query).toBeUndefined()
  })

  it('drops the events past the cap while the queue does not answer, and takes them again after', async () => {
    const waiting: (() => void)[] = []
    add.mockImplementation(
      () =>
        new Promise<void>(resolve => {
          waiting.push(resolve)
        })
    )
    for (let n = 0; n < SearchTracking.MAX_IN_FLIGHT + 5; n++) {
      tracker.track(STORE, SearchTrackedScopes.CUSTOMERS, 'ab', 1, performance.now())
    }
    expect(add).toHaveBeenCalledTimes(SearchTracking.MAX_IN_FLIGHT)
    waiting.forEach(resolve => resolve())
    await new Promise(resolve => setImmediate(resolve))
    tracker.track(STORE, SearchTrackedScopes.CUSTOMERS, 'ab', 1, performance.now())
    expect(add).toHaveBeenCalledTimes(SearchTracking.MAX_IN_FLIGHT + 1)
  })

  it('never fails the search when the queue throws at once either', () => {
    add.mockImplementation(() => {
      throw new Error('queue closed')
    })
    expect(() =>
      tracker.track(STORE, SearchTrackedScopes.CUSTOMERS, 'ab', 1, performance.now())
    ).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('never fails the search when the queue does: it logs and goes on', async () => {
    add.mockRejectedValue(new Error('redis down'))
    expect(() =>
      tracker.track(STORE, SearchTrackedScopes.CUSTOMERS, 'ab', 1, performance.now())
    ).not.toThrow()
    await new Promise(resolve => setImmediate(resolve))
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
