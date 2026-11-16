import {
  emptyManualEntryDraft,
  ManualEntryFields,
  manualEntryInputOf,
  manualEntryProblem,
  manualEntryTotals,
  type ManualEntryDraft,
  type ManualLineDraft
} from './manual-entry-form'

const TODAY = '2026-11-16'
const balanced = (): ManualEntryDraft => ({
  ...emptyManualEntryDraft(TODAY, ['a', 'b']),
  memo: 'Opening',
  lines: [
    { key: 'a', accountId: 'cash', debit: '15.50', credit: '', memo: '' },
    { key: 'b', accountId: 'equity', debit: '', credit: '15.50', memo: ' Capital ' }
  ]
})

describe('manualEntryProblem', () => {
  it('accepts a balanced entry', () => {
    expect(manualEntryProblem(balanced())).toBeNull()
  })

  it('names the first thing that is wrong', () => {
    expect(manualEntryProblem({ ...balanced(), entryDate: '2026-02-30' })?.field).toBe(
      ManualEntryFields.DATE
    )
    expect(manualEntryProblem({ ...balanced(), memo: '  ' })?.field).toBe(ManualEntryFields.MEMO)
    expect(manualEntryProblem({ ...balanced(), lines: balanced().lines.slice(0, 1) })?.field).toBe(
      ManualEntryFields.LINES
    )
  })

  it('names the line that has no account, no amount, or both sides', () => {
    const draft = balanced()
    const [first, second] = draft.lines as [ManualLineDraft, ManualLineDraft]
    const withLines = (...lines: ManualLineDraft[]): ManualEntryDraft => ({ ...draft, lines })
    expect(manualEntryProblem(withLines({ ...first, accountId: '' }, second))).toEqual({
      field: ManualEntryFields.LINE,
      index: 0
    })
    expect(manualEntryProblem(withLines(first, { ...second, debit: '1' }))).toEqual({
      field: ManualEntryFields.LINE,
      index: 1
    })
    expect(manualEntryProblem(withLines({ ...first, debit: '' }, second))).toEqual({
      field: ManualEntryFields.LINE,
      index: 0
    })
    expect(manualEntryProblem(withLines({ ...first, debit: '1.234' }, second))).toEqual({
      field: ManualEntryFields.LINE,
      index: 0
    })
  })

  it('reads a typed zero on the other side as nothing, and refuses a total no line can hold', () => {
    const draft = balanced()
    const [first, second] = draft.lines as [ManualLineDraft, ManualLineDraft]
    expect(
      manualEntryProblem({
        ...draft,
        lines: [
          { ...first, credit: '0' },
          { ...second, debit: '0.00' }
        ]
      })
    ).toBeNull()
    const huge = {
      ...draft,
      lines: [
        { ...first, debit: '21474836.47' },
        { ...second, credit: '21474836.47' }
      ]
    }
    expect(manualEntryProblem(huge)).toBeNull()
    const over = {
      ...draft,
      lines: [
        { ...first, debit: '21474836.47' },
        { ...first, key: 'c', debit: '0.01' },
        { ...second, credit: '21474836.48' }
      ]
    }
    expect(manualEntryProblem(over)).toEqual({ field: ManualEntryFields.TOTAL, index: null })
  })

  it('counts a memo in UTF-16 units like the request schema of the api', () => {
    expect(manualEntryProblem({ ...balanced(), memo: '😀'.repeat(250) })).toBeNull()
    expect(manualEntryProblem({ ...balanced(), memo: '😀'.repeat(251) })?.field).toBe(
      ManualEntryFields.MEMO
    )
  })

  it('refuses an entry whose sides differ by one cent', () => {
    const draft = balanced()
    const [first, second] = draft.lines as [ManualLineDraft, ManualLineDraft]
    const off = { ...draft, lines: [first, { ...second, credit: '15.49' }] }
    expect(manualEntryProblem(off)).toEqual({ field: ManualEntryFields.BALANCE, index: null })
  })
})

describe('manualEntryTotals and manualEntryInputOf', () => {
  it('adds each side in whole cents', () => {
    expect(manualEntryTotals(balanced().lines)).toEqual({ debitCents: 1550, creditCents: 1550 })
  })

  it('sends whole cents, the trimmed memo of a line only when it has one, and the key of the form', () => {
    expect(manualEntryInputOf(balanced(), 'once-per-form')).toEqual({
      idempotencyKey: 'once-per-form',
      entryDate: TODAY,
      type: 'manual',
      memo: 'Opening',
      lines: [
        { accountId: 'cash', debitCents: 1550, creditCents: 0 },
        { accountId: 'equity', debitCents: 0, creditCents: 1550, memo: 'Capital' }
      ]
    })
  })
})
