import { FiscalLimits, FiscalVoidKind, voidFiscalDocumentSchema } from '@platform/core/domain'

import {
  EMPTY_VOID_PARTY,
  voidBodyOf,
  voidFormProblems,
  voidReasonProblem,
  type VoidDraft,
  type VoidInputsView
} from './void-form'

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

  it('refuses what the api refuses beyond blanks and length: a line break, an invisible character', () => {
    expect(voidReasonProblem('checked\nwith the authority')).toBe('invalid')
    expect(voidReasonProblem('zero\u200Bwidth')).toBe('invalid')
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

describe('the form of an invalidation that asks for more than a reason', () => {
  const party = { name: 'Ana Pérez', idType: '13', idNumber: '012345678' }
  const inputs: VoidInputsView = {
    kinds: [FiscalVoidKind.CORRECTION, FiscalVoidKind.RESCISSION, FiscalVoidKind.OTHER],
    requiresParties: true,
    kindsWithReplacement: [FiscalVoidKind.CORRECTION, FiscalVoidKind.OTHER],
    reasonMaxLength: 200
  }
  const draft = (over: Partial<VoidDraft> = {}): VoidDraft => ({
    reason: 'wrong customer',
    kind: FiscalVoidKind.RESCISSION,
    responsible: party,
    requester: party,
    replacementDocumentId: '',
    ...over
  })

  it('asks the reason alone when the provider asks nothing else', () => {
    expect(
      voidFormProblems({ ...draft(), kind: '', responsible: EMPTY_VOID_PARTY }, undefined)
    ).toEqual([])
    expect(voidBodyOf(draft({ reason: ' wrong ' }), undefined)).toEqual({ reason: 'wrong' })
  })

  it('counts the reason by the limit of the authority, which is shorter than the api’s', () => {
    expect(voidReasonProblem('a'.repeat(200), 200)).toBeNull()
    expect(voidReasonProblem('a'.repeat(201), 200)).toBe('tooLong')
    expect(voidReasonProblem('a'.repeat(201))).toBeNull()
  })

  it('needs the kind, both people, and the replacement only for the kinds that name one', () => {
    expect(voidFormProblems(draft(), inputs)).toEqual([])
    expect(voidFormProblems(draft({ kind: '' }), inputs)).toEqual([
      { field: 'kind', problem: 'required' }
    ])
    expect(
      voidFormProblems(
        draft({ responsible: { ...party, idNumber: ' ' }, requester: EMPTY_VOID_PARTY }),
        inputs
      )
    ).toEqual([
      { field: 'responsible', problem: 'required' },
      { field: 'requester', problem: 'required' }
    ])
    expect(
      voidFormProblems(draft({ requester: { ...party, idNumber: '1'.repeat(21) } }), inputs)
    ).toEqual([{ field: 'requester', problem: 'tooLong' }])
    expect(voidFormProblems(draft({ kind: FiscalVoidKind.CORRECTION }), inputs)).toEqual([
      { field: 'replacement', problem: 'required' }
    ])
  })

  it('takes only a kind of identity document of the provider list when it has one', () => {
    const codes = ['13', '36']
    expect(voidFormProblems(draft(), inputs, codes)).toEqual([])
    expect(
      voidFormProblems(draft({ responsible: { ...party, idType: '99' } }), inputs, codes)
    ).toEqual([{ field: 'responsible', problem: 'required' }])
    // With no list, what is typed is taken
    expect(voidFormProblems(draft({ responsible: { ...party, idType: '99' } }), inputs)).toEqual([])
  })

  it('sends only what the chosen kind needs, in a body the api reads', () => {
    const rescission = voidBodyOf(draft({ replacementDocumentId: 'stale' }), inputs)
    expect(rescission).not.toHaveProperty('replacementDocumentId')
    expect(voidFiscalDocumentSchema.safeParse(rescission).success).toBe(true)
    const correction = voidBodyOf(
      draft({
        kind: FiscalVoidKind.CORRECTION,
        replacementDocumentId: '2b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed',
        responsible: { name: ' Ana ', idType: '13', idNumber: ' 1 ' }
      }),
      inputs
    )
    expect(correction).toMatchObject({
      kind: 'correction',
      replacementDocumentId: '2b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed',
      responsible: { name: 'Ana', idNumber: '1' }
    })
    expect(voidFiscalDocumentSchema.safeParse(correction).success).toBe(true)
  })

  it('leaves out the people when the provider does not ask for them', () => {
    const body = voidBodyOf(draft(), { ...inputs, requiresParties: false })
    expect(body).toEqual({ reason: 'wrong customer', kind: 'rescission' })
    expect(
      voidFormProblems(draft({ responsible: EMPTY_VOID_PARTY }), {
        ...inputs,
        requiresParties: false
      })
    ).toEqual([])
  })
})
