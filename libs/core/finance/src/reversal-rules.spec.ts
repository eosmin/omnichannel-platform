import { isRetryOfReversal } from './reversal-rules'

const stored = {
  createdBy: 'person-a',
  memo: 'Duplicated payment',
  entryDate: new Date('2026-11-12T00:00:00Z')
}
const same = { createdBy: 'person-a', memo: 'Duplicated payment', entryDate: null }

describe('isRetryOfReversal', () => {
  it('is the same author asking for the same reason, with the day free or the day it was written on', () => {
    expect(isRetryOfReversal(stored, same)).toBe(true)
    expect(isRetryOfReversal(stored, { ...same, entryDate: '2026-11-12' })).toBe(true)
    expect(isRetryOfReversal(stored, { ...same, memo: '  Duplicated payment  ' })).toBe(true)
  })

  it('is not another person, another reason or another day', () => {
    expect(isRetryOfReversal(stored, { ...same, createdBy: 'person-b' })).toBe(false)
    expect(isRetryOfReversal(stored, { ...same, memo: 'Another reason' })).toBe(false)
    expect(isRetryOfReversal(stored, { ...same, entryDate: '2026-11-13' })).toBe(false)
    // The system's earlier reversal is not a person's act, and a blank reason matches no stored one
    expect(isRetryOfReversal({ ...stored, createdBy: null }, same)).toBe(false)
    expect(isRetryOfReversal({ ...stored, memo: null }, same)).toBe(false)
    expect(isRetryOfReversal(stored, { ...same, memo: '   ' })).toBe(false)
  })

  it('answers the system with any reversal that exists, whoever wrote it and on whatever day', () => {
    const system = { createdBy: null, memo: 'auto:remittance_void', entryDate: '2026-12-01' }
    expect(isRetryOfReversal(stored, system)).toBe(true)
    expect(isRetryOfReversal({ ...stored, createdBy: null }, system)).toBe(true)
  })
})
