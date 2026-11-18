import { recordPaymentReturnSchema } from '@platform/core/domain'

import { emptyReturnDraft, ReturnFields, returnInputOf, returnProblem } from './payment-return-form'

const payment = { paidFromAccountId: 'acc-bank', amountCents: 5000, paidOn: '2026-11-10' }
const TODAY = '2026-11-18'
const ATTEMPT = crypto.randomUUID()

describe('payment return form', () => {
  it('starts on the account the payment left from, the whole payment and today', () => {
    expect(emptyReturnDraft(TODAY, payment)).toEqual({
      receivedIntoAccountId: 'acc-bank',
      amount: '50.00',
      returnedOn: TODAY,
      reference: ''
    })
  })

  it('names the first field that is wrong', () => {
    const draft = emptyReturnDraft(TODAY, payment)
    expect(returnProblem(draft, payment, TODAY)).toBeNull()
    expect(returnProblem({ ...draft, receivedIntoAccountId: '' }, payment, TODAY)).toBe(
      ReturnFields.ACCOUNT
    )
    for (const amount of ['', '0', '-1', 'x', '50.01', '1.234']) {
      expect(returnProblem({ ...draft, amount }, payment, TODAY)).toBe(ReturnFields.AMOUNT)
    }
    expect(returnProblem({ ...draft, returnedOn: '2026-13-01' }, payment, TODAY)).toBe(
      ReturnFields.DATE
    )
    // not before the payment, not in the future
    expect(returnProblem({ ...draft, returnedOn: '2026-11-09' }, payment, TODAY)).toBe(
      ReturnFields.DATE
    )
    expect(returnProblem({ ...draft, returnedOn: '2026-11-19' }, payment, TODAY)).toBe(
      ReturnFields.DATE
    )
    expect(returnProblem({ ...draft, reference: 'x'.repeat(500) }, payment, TODAY)).toBe(
      ReturnFields.REFERENCE
    )
  })

  it('builds a body the server schema takes', () => {
    const draft = {
      ...emptyReturnDraft(TODAY, payment),
      amount: '12.50',
      reference: '  NSF 7  '
    }
    const input = returnInputOf(draft, ATTEMPT)
    expect(input).toEqual({
      idempotencyKey: ATTEMPT,
      receivedIntoAccountId: 'acc-bank',
      amountCents: 1250,
      returnedOn: TODAY,
      reference: 'NSF 7'
    })
    expect(
      recordPaymentReturnSchema.safeParse({ ...input, receivedIntoAccountId: crypto.randomUUID() })
        .success
    ).toBe(true)
    const bare = returnInputOf({ ...draft, reference: '   ' }, ATTEMPT)
    expect('reference' in bare).toBe(false)
  })
})
