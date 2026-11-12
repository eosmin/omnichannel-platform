import { CustomerLimits } from '@platform/core/domain'

import { flagReasonOf } from './return-reception.rules'

describe('flagReasonOf', () => {
  it('prefers the reason the agent wrote, trimmed', () => {
    expect(flagReasonOf({ flagReason: '  Refused twice ', note: 'a note' })).toBe('Refused twice')
  })

  it('falls back to the note, in one line', () => {
    expect(flagReasonOf({ flagReason: null, note: ' Said it was\n a  gift ' })).toBe(
      'Said it was a gift'
    )
    expect(flagReasonOf({ flagReason: '   ', note: 'from the note' })).toBe('from the note')
  })

  it('cuts a long note to what a flag holds', () => {
    const reason = flagReasonOf({ flagReason: null, note: 'x'.repeat(2000) })
    expect(reason).toHaveLength(CustomerLimits.CAUTION_REASON_MAX_LENGTH)
  })

  it('answers null when there is neither', () => {
    expect(flagReasonOf({ flagReason: null, note: null })).toBeNull()
    expect(flagReasonOf({ flagReason: ' ', note: '  \n ' })).toBeNull()
  })
})
