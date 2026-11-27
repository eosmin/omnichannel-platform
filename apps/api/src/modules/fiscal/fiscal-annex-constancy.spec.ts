import { FiscalAnnexNotices } from '@platform/core/domain'

import { movedSince } from './fiscal-annex-constancy'

const sha = (letter: string): string => letter.repeat(64)

describe('movedSince', () => {
  const before = [
    { receiptId: 'r1', sourceSha256: sha('a') },
    { receiptId: 'r2', sourceSha256: sha('b') },
    { receiptId: 'r3', sourceSha256: sha('c') }
  ]

  it('only says that the month was exported before when nothing moved', () => {
    const now = before.map(item => ({ receiptId: item.receiptId, sha256: item.sourceSha256 }))
    expect(movedSince(before, now)).toEqual({ [FiscalAnnexNotices.RE_EXPORT]: 1 })
  })

  it('counts the receipts that changed, came in and went out, each apart', () => {
    const now = [
      { receiptId: 'r1', sha256: sha('a') },
      { receiptId: 'r2', sha256: sha('z') },
      { receiptId: 'r4', sha256: sha('d') },
      { receiptId: 'r5', sha256: sha('e') }
    ]
    expect(movedSince(before, now)).toEqual({
      [FiscalAnnexNotices.RE_EXPORT]: 1,
      [FiscalAnnexNotices.CHANGED_SINCE_EXPORT]: 1,
      [FiscalAnnexNotices.ADDED_SINCE_EXPORT]: 2,
      [FiscalAnnexNotices.REMOVED_SINCE_EXPORT]: 1
    })
  })

  it('reads an export with no receipts', () => {
    expect(movedSince([], [])).toEqual({ [FiscalAnnexNotices.RE_EXPORT]: 1 })
  })
})
