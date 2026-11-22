import { ApiError } from '@platform/api-client'

import {
  auditFilterOf,
  EMPTY_AUDIT_FILTER,
  isAuditRangeReversed,
  isExportTooLarge,
  metadataText,
  shortId
} from './audit-log-filter'

describe('auditFilterOf', () => {
  it('narrows nothing when every field is empty', () => {
    expect(auditFilterOf(EMPTY_AUDIT_FILTER)).toEqual({
      action: undefined,
      userId: undefined,
      from: undefined,
      before: undefined
    })
  })

  it('cuts the spaces around the action and sends the actor as picked', () => {
    const filter = auditFilterOf({
      ...EMPTY_AUDIT_FILTER,
      action: '  order.created ',
      userId: 'u1'
    })
    expect(filter.action).toBe('order.created')
    expect(filter.userId).toBe('u1')
  })

  it('takes the last day whole: `before` is the first instant of the day after it', () => {
    const filter = auditFilterOf({ ...EMPTY_AUDIT_FILTER, from: '2026-11-01', to: '2026-11-30' })
    expect(filter.from).toBe(new Date('2026-11-01T00:00:00').toISOString())
    expect(filter.before).toBe(new Date('2026-12-01T00:00:00').toISOString())
  })

  it('crosses a month and a year end', () => {
    const filter = auditFilterOf({ ...EMPTY_AUDIT_FILTER, to: '2026-12-31' })
    expect(filter.before).toBe(new Date('2027-01-01T00:00:00').toISOString())
  })

  it('leaves a malformed day out instead of sending a broken instant', () => {
    const filter = auditFilterOf({ ...EMPTY_AUDIT_FILTER, from: '2026-13-45', to: 'soon' })
    expect(filter.from).toBeUndefined()
    expect(filter.before).toBeUndefined()
  })
})

describe('isAuditRangeReversed', () => {
  it('is true only when both days are set and the start is after the end', () => {
    expect(isAuditRangeReversed({ from: '2026-11-10', to: '2026-11-01' })).toBe(true)
    expect(isAuditRangeReversed({ from: '2026-11-01', to: '2026-11-01' })).toBe(false)
    expect(isAuditRangeReversed({ from: '2026-11-01', to: '' })).toBe(false)
    expect(isAuditRangeReversed({ from: '', to: '' })).toBe(false)
  })
})

describe('isExportTooLarge', () => {
  it('recognises the code of the ceiling and nothing else', () => {
    expect(isExportTooLarge(new ApiError(400, 'EXPORT_TOO_LARGE', 'x'))).toBe(true)
    expect(isExportTooLarge(new ApiError(400, 'VALIDATION_FAILED', 'x'))).toBe(false)
    expect(isExportTooLarge(new Error('EXPORT_TOO_LARGE'))).toBe(false)
  })
})

describe('metadataText', () => {
  it('writes an object as indented JSON and nothing for an absent value', () => {
    expect(metadataText({ items: 2 })).toBe('{\n  "items": 2\n}')
    expect(metadataText(null)).toBe('')
    expect(metadataText(undefined)).toBe('')
  })

  it('does not throw on a value JSON cannot write', () => {
    const cycle: Record<string, unknown> = {}
    cycle['self'] = cycle
    expect(metadataText(cycle)).toBe('')
  })
})

describe('shortId', () => {
  it('keeps the first eight characters', () => {
    expect(shortId('0b0d6b1e-5a7e-4a52-9d65-0a6f3f0e9c11')).toBe('0b0d6b1e')
    expect(shortId('abc')).toBe('abc')
  })
})
