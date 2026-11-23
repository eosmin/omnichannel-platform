import {
  DsrLegalBaseCodes,
  DsrNoticeStatuses,
  DsrReviewCodes,
  DSR_SUMMARY_COUNT_ORDER,
  DsrStatus,
  DsrType
} from '@platform/core/domain'

import en from '../../messages/en.json'
import es from '../../messages/es.json'

// A value the api can send with no words for it would draw "unknown" in front of a reviewer: every one has its text, in both languages.
describe.each([
  ['en', en.settings.dataRequests],
  ['es', es.settings.dataRequests]
])('the texts of the data requests in %s', (_language, messages) => {
  const keysOf = (group: Record<string, unknown>): string[] => Object.keys(group).sort()

  it('has a text for every type and every status', () => {
    expect(keysOf(messages.types)).toEqual([...Object.values(DsrType), 'unknown'].sort())
    expect(keysOf(messages.statuses)).toEqual([...Object.values(DsrStatus), 'unknown'].sort())
  })

  it('has a text for every code, every notice state and every legal basis', () => {
    expect(keysOf(messages.failure.codes)).toEqual(
      [...Object.values(DsrReviewCodes), 'unknown'].sort()
    )
    expect(keysOf(messages.notice.statuses)).toEqual(
      [...Object.values(DsrNoticeStatuses), 'unknown'].sort()
    )
    expect(keysOf(messages.summary.bases)).toEqual(
      [...Object.values(DsrLegalBaseCodes), 'unknown'].sort()
    )
  })

  it('has a text for every count a summary can carry', () => {
    expect(keysOf(messages.summary.counts)).toEqual([...DSR_SUMMARY_COUNT_ORDER].sort())
  })

  it('has the three decisions, each with what it does and what confirms it', () => {
    for (const kind of ['approveErasure', 'approveExport', 'reject', 'cancel'] as const) {
      const block = messages.decision[kind]
      expect(Object.keys(block.effects).length).toBeGreaterThan(0)
      for (const key of [
        'title',
        'submit',
        'confirm',
        'confirmTitle',
        'confirmDescription',
        'done'
      ]) {
        expect(block).toHaveProperty(key)
      }
    }
  })
})
