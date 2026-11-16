import { confirmFiscalIssuerChangeSchema, FiscalLimits } from '@platform/core/domain'

import { issuerChangeReasonProblem } from './issuer-change-form'

describe('the reason to confirm an issuer change', () => {
  it('is needed, and is not blanks', () => {
    expect(issuerChangeReasonProblem('')).toBe('required')
    expect(issuerChangeReasonProblem('   ')).toBe('required')
  })

  it('has the length the api takes, and no more', () => {
    const longest = 'a'.repeat(FiscalLimits.VOID_REASON_MAX_LENGTH)
    expect(issuerChangeReasonProblem(longest)).toBeNull()
    expect(issuerChangeReasonProblem(`${longest}a`)).toBe('tooLong')
  })

  it('refuses a line break and an invisible character, which the api refuses', () => {
    for (const reason of ['checked\nwith the authority', 'zero\u200Bwidth']) {
      expect(issuerChangeReasonProblem(reason)).toBe('invalid')
      expect(confirmFiscalIssuerChangeSchema.safeParse({ reason }).success).toBe(false)
    }
  })

  it('agrees with the schema of the api on what it lets through', () => {
    for (const reason of [
      'checked with the old authority',
      ' padded ',
      'a'.repeat(FiscalLimits.VOID_REASON_MAX_LENGTH)
    ]) {
      expect(issuerChangeReasonProblem(reason)).toBeNull()
      expect(confirmFiscalIssuerChangeSchema.safeParse({ reason: reason.trim() }).success).toBe(
        true
      )
    }
    for (const reason of ['', '   ', 'a'.repeat(FiscalLimits.VOID_REASON_MAX_LENGTH + 1)]) {
      expect(issuerChangeReasonProblem(reason)).not.toBeNull()
      expect(confirmFiscalIssuerChangeSchema.safeParse({ reason: reason.trim() }).success).toBe(
        false
      )
    }
  })
})
