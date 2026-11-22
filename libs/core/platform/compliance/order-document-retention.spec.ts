import { OrderDocumentRetention, orderDocumentCutoff } from './order-document-retention'

const at = (iso: string): Date => new Date(iso)

describe('orderDocumentCutoff', () => {
  it('is seven calendar years before now (the proposal of the plan: the period of the books)', () => {
    expect(OrderDocumentRetention.LEGAL_YEARS).toBe(7)
    expect(orderDocumentCutoff(at('2033-06-15T03:00:00Z')).toISOString()).toBe(
      '2026-06-15T03:00:00.000Z'
    )
  })

  it('keeps a document of six years and eleven months, and takes one of seven years and a day', () => {
    const now = at('2033-06-15T03:00:00Z')
    const cutoff = orderDocumentCutoff(now)
    const young = at('2026-07-15T03:00:00Z')
    const old = at('2026-06-14T03:00:00Z')
    expect(young.getTime() < cutoff.getTime()).toBe(false)
    expect(old.getTime() < cutoff.getTime()).toBe(true)
  })

  it('never lands a day early when the day does not exist seven years back (29 February)', () => {
    // 29 Feb 2028 minus seven years has no 29 Feb: the cutoff is 28 Feb 2021 at the latest, never 1 March
    const cutoff = orderDocumentCutoff(at('2028-02-29T03:00:00Z'))
    expect(cutoff.getTime()).toBeLessThanOrEqual(at('2021-02-28T03:00:00Z').getTime())
  })
})
