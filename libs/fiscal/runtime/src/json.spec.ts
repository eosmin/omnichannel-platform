import { FiscalLimits } from '@platform/core/domain'

import { cappedResponse, plainText, record, toJson } from './json'

describe('what comes out of a provider', () => {
  it('takes the round trip through JSON: what is not data goes, and a cycle fails', () => {
    expect(toJson({ a: 1, f: () => 1, u: undefined })).toEqual({ a: 1 })
    const cycle: Record<string, unknown> = {}
    cycle['self'] = cycle
    expect(() => toJson(cycle)).toThrow()
  })

  it('drops the NUL character of a text: the database refuses it', () => {
    expect(toJson({ note: 'a\u0000b' })).toEqual({ note: 'ab' })
  })

  it('cleans the keys too, and the lone surrogate that a database refuses', () => {
    expect(toJson({ ['k\u0000ey']: 'x', bad: 'a\ud800b' })).toEqual({ key: 'x', bad: 'a\ufffdb' })
    expect(plainText('ok \ud83d\ude00')).toBe('ok \ud83d\ude00')
    expect(plainText('n\u0000o')).toBe('no')
  })

  it('stores no more of a response than the limit and says it cut it, never half of it', () => {
    expect(cappedResponse({ ok: true })).toEqual({ ok: true })
    const big = { body: 'y'.repeat(FiscalLimits.RESPONSE_MAX_CHARS) }
    expect(cappedResponse(big)).toEqual({ truncated: true })
  })

  it('reads a record out of anything', () => {
    expect(record({ a: 1 })).toEqual({ a: 1 })
    expect(record(null)).toEqual({})
    expect(record([1])).toEqual({})
  })
})
