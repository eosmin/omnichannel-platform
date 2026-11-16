import { FiscalLimits, voidFiscalDocumentSchema } from '@platform/core/domain'

import { voidReasonProblem } from './void-form'

describe('the reason to void a fiscal document', () => {
  it('is needed, and is not blanks', () => {
    expect(voidReasonProblem('')).toBe('required')
    expect(voidReasonProblem('   ')).toBe('required')
  })

  it('has the length the api takes, and no more', () => {
    const longest = 'a'.repeat(FiscalLimits.VOID_REASON_MAX_LENGTH)
    expect(voidReasonProblem(longest)).toBeNull()
    expect(voidReasonProblem(`${longest}a`)).toBe('tooLong')
  })

  it('agrees with the schema of the api on what it lets through', () => {
    for (const reason of [
      'wrong receiver',
      ' padded ',
      'a'.repeat(FiscalLimits.VOID_REASON_MAX_LENGTH)
    ]) {
      expect(voidReasonProblem(reason)).toBeNull()
      expect(voidFiscalDocumentSchema.safeParse({ reason: reason.trim() }).success).toBe(true)
    }
    for (const reason of ['', '   ', 'a'.repeat(FiscalLimits.VOID_REASON_MAX_LENGTH + 1)]) {
      expect(voidReasonProblem(reason)).not.toBeNull()
      expect(voidFiscalDocumentSchema.safeParse({ reason: reason.trim() }).success).toBe(false)
    }
  })
})
