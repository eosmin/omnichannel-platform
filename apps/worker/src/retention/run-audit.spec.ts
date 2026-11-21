import { runAuditMetadata, runHasNews } from './run-audit'

describe('the audit entry of a nightly run', () => {
  it('keeps only the counts of the report, and the names of what stopped or failed', () => {
    const report = { sessions: 2, tokens: 0, label: 'not a count', list: [1], nothing: null }

    const metadata = runAuditMetadata(report, ['sessions'], ['tokens'])

    expect(metadata).toEqual({
      counts: { sessions: 2, tokens: 0 },
      more: ['sessions'],
      failed: ['tokens']
    })
  })

  it('is news when something was deleted, stopped on a full batch or failed, and is not when none of them', () => {
    expect(runHasNews(runAuditMetadata({ a: 1 }, [], []))).toBe(true)
    expect(runHasNews(runAuditMetadata({ a: 0 }, ['a'], []))).toBe(true)
    expect(runHasNews(runAuditMetadata({ a: 0 }, [], ['a']))).toBe(true)
    expect(runHasNews(runAuditMetadata({ a: 0, b: 0 }, [], []))).toBe(false)
  })

  it('does not count what was only looked at as news', () => {
    const looked = runAuditMetadata({ customers: 3, skipped: 3, cleared: 0 }, [], [])
    const done = runAuditMetadata({ customers: 3, skipped: 2, cleared: 1 }, [], [])

    expect(runHasNews(looked, ['customers', 'skipped'])).toBe(false)
    expect(runHasNews(done, ['customers', 'skipped'])).toBe(true)
  })
})
