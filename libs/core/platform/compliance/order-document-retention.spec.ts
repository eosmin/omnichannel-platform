import { OrderDocumentRetention, orderDocumentCutoff } from './order-document-retention'

const at = (iso: string): Date => new Date(iso)

describe('orderDocumentCutoff', () => {
  it('is ten calendar years before now (Codigo Tributario art. 147: the period of the books)', () => {
    expect(OrderDocumentRetention.LEGAL_YEARS).toBe(10)
    expect(orderDocumentCutoff(at('2036-06-15T03:00:00Z')).toISOString()).toBe(
      '2026-06-15T03:00:00.000Z'
    )
  })

  it('keeps a document of nine years and eleven months, and takes one of ten years and a day', () => {
    const now = at('2036-06-15T03:00:00Z')
    const cutoff = orderDocumentCutoff(now)
    const young = at('2026-07-15T03:00:00Z')
    const old = at('2026-06-14T03:00:00Z')
    expect(young.getTime() < cutoff.getTime()).toBe(false)
    expect(old.getTime() < cutoff.getTime()).toBe(true)
  })

  it('keeps a document of exactly ten years: the cutoff itself is not past the period', () => {
    const now = at('2036-06-15T03:00:00Z')
    expect(at('2026-06-15T03:00:00Z').getTime() < orderDocumentCutoff(now).getTime()).toBe(false)
  })

  it('never takes a document before seven, eight or nine years and a day (the old period)', () => {
    const now = at('2036-06-15T03:00:00Z')
    const cutoff = orderDocumentCutoff(now)
    for (const issuedAt of ['2029-06-14T03:00:00Z', '2027-06-14T03:00:00Z']) {
      expect(at(issuedAt).getTime() < cutoff.getTime()).toBe(false)
    }
  })

  it('never lands a day early when the day does not exist ten years back (29 February)', () => {
    // 29 Feb 2032 minus ten years has no 29 Feb: the cutoff is 28 Feb 2022 at the latest, never 1 March
    const cutoff = orderDocumentCutoff(at('2032-02-29T03:00:00Z'))
    expect(cutoff.getTime()).toBeLessThanOrEqual(at('2022-02-28T03:00:00Z').getTime())
  })
})
