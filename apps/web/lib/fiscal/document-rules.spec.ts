import type { FiscalDocumentView } from '@platform/api-client'
import {
  FiscalConflictReasons,
  FiscalDocumentKind,
  FiscalDocumentStatus,
  FiscalLimits,
  FiscalRejectionReasons
} from '@platform/core/domain'

import {
  conflictReasonOf,
  coreRejectionOf,
  fiscalActionsOf,
  FiscalAttention,
  fiscalAttentionOf,
  replacedIdsOf
} from './document-rules'

const base = {
  id: 'd1',
  kind: FiscalDocumentKind.SALE,
  status: FiscalDocumentStatus.ACCEPTED,
  attempts: 1
}
const none = new Set<string>()

describe('what a person may do with a fiscal document', () => {
  it('voids an accepted one, and only an accepted one', () => {
    for (const status of Object.values(FiscalDocumentStatus)) {
      expect(fiscalActionsOf({ ...base, status }, none).void).toBe(
        status === FiscalDocumentStatus.ACCEPTED
      )
    }
  })

  it('sends again a refused one or one waiting in the queue', () => {
    for (const status of Object.values(FiscalDocumentStatus)) {
      expect(fiscalActionsOf({ ...base, status }, none).retry).toBe(
        status === FiscalDocumentStatus.REJECTED || status === FiscalDocumentStatus.QUEUED
      )
    }
  })

  it('fixes the receiver of a refused sale document, or of one never sent, and never of one that may be at the authority', () => {
    const edit = (status: FiscalDocumentStatus, attempts: number, kind = FiscalDocumentKind.SALE) =>
      fiscalActionsOf({ ...base, status, attempts, kind }, none).editReceiver
    expect(edit(FiscalDocumentStatus.REJECTED, 3)).toBe(true)
    expect(edit(FiscalDocumentStatus.QUEUED, 0)).toBe(true)
    expect(edit(FiscalDocumentStatus.QUEUED, 1)).toBe(false)
    expect(edit(FiscalDocumentStatus.SUBMITTED, 0)).toBe(false)
    expect(edit(FiscalDocumentStatus.ACCEPTED, 0)).toBe(false)
    // The receiver of a credit note is its sale document's
    expect(edit(FiscalDocumentStatus.REJECTED, 1, FiscalDocumentKind.CREDIT_NOTE)).toBe(false)
  })

  it('makes a voided sale document again once, never a credit note and never one that has its replacement', () => {
    const voided = { ...base, status: FiscalDocumentStatus.VOIDED }
    expect(fiscalActionsOf(voided, none).replace).toBe(true)
    expect(fiscalActionsOf(voided, new Set(['d1'])).replace).toBe(false)
    expect(fiscalActionsOf({ ...voided, kind: FiscalDocumentKind.CREDIT_NOTE }, none).replace).toBe(
      false
    )
    expect(fiscalActionsOf({ ...base, status: FiscalDocumentStatus.ACCEPTED }, none).replace).toBe(
      false
    )
  })

  it('knows which voided documents have a replacement among the ones it was given', () => {
    const documents = [
      { replacesDocumentId: 'a' },
      { replacesDocumentId: null },
      { replacesDocumentId: 'b' }
    ] as FiscalDocumentView[]
    expect([...replacedIdsOf(documents)].sort()).toEqual(['a', 'b'])
  })
})

describe('what needs attention', () => {
  it('flags a refusal, and a queued document that spent every attempt', () => {
    expect(fiscalAttentionOf({ status: FiscalDocumentStatus.REJECTED, attempts: 1 })).toBe(
      FiscalAttention.REJECTED
    )
    expect(
      fiscalAttentionOf({
        status: FiscalDocumentStatus.QUEUED,
        attempts: FiscalLimits.MAX_ATTEMPTS
      })
    ).toBe(FiscalAttention.STUCK)
    expect(
      fiscalAttentionOf({
        status: FiscalDocumentStatus.QUEUED,
        attempts: FiscalLimits.MAX_ATTEMPTS - 1
      })
    ).toBeNull()
    expect(fiscalAttentionOf({ status: FiscalDocumentStatus.ACCEPTED, attempts: 9 })).toBeNull()
  })

  it('has words for the reasons of core and shows a reason of a provider as it came', () => {
    for (const reason of Object.values(FiscalRejectionReasons)) {
      expect(coreRejectionOf(reason)).toBe(reason)
    }
    expect(coreRejectionOf('provider_own_code')).toBeNull()
    expect(coreRejectionOf(null)).toBeNull()
  })

  it('reads the reason of a refused action only when it is one it knows', () => {
    for (const reason of Object.values(FiscalConflictReasons)) {
      expect(conflictReasonOf(reason)).toBe(reason)
    }
    expect(conflictReasonOf('other')).toBeNull()
    expect(conflictReasonOf(5)).toBeNull()
  })
})
