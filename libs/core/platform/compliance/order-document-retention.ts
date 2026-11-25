// The documents of an order (its summary, its label) outlive the conversation they were sent in (TDD_05 §10.4) and go after the legal period
// of the books (TDD_05 §10.3). The period is TEN years, the one the Codigo Tributario of El Salvador (art. 147) sets for the books, the vouchers
// and the electronic tax documents, counted from their issue (owner, 2026-11-25). Which documents count as a voucher is still a question for
// the accountant, so everything of the books is kept the ten years. `DataRetentionPolicies.ORDERS` names the same period.
// It is counted in calendar years, never in days, so that a leap year can only make the
// document stay a day longer, never go a day early.
export const OrderDocumentRetention = {
  LEGAL_YEARS: 10
} as const

// A document made before this instant is past the period. `now` is read once by the run, so a run that lasts past midnight keeps one cutoff.
export function orderDocumentCutoff(now: Date): Date {
  const cutoff = new Date(now.getTime())
  const day = cutoff.getUTCDate()
  cutoff.setUTCDate(1)
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - OrderDocumentRetention.LEGAL_YEARS)
  // 29 February has no ten years back in most years: take the last day of that month, which is earlier than the first of the next
  const lastDay = new Date(
    Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth() + 1, 0)
  ).getUTCDate()
  cutoff.setUTCDate(Math.min(day, lastDay))
  return cutoff
}
