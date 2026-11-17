import type { FiscalDocumentView } from '@platform/api-client'
import {
  FiscalConflictReasons,
  FiscalDocumentKind,
  FiscalDocumentStatus,
  FiscalEvidenceKind,
  FiscalLimits,
  FiscalRejectionReasons
} from '@platform/core/domain'

import {
  conflictReasonOf,
  coreRejectionOf,
  fiscalActionsOf,
  FiscalAttention,
  fiscalAttentionOf,
  fiscalEvidenceKindsOf,
  isIssuerChangedInFlight,
  replacedIdsOf
} from './document-rules'

const base = {
  id: 'd1',
  kind: FiscalDocumentKind.SALE,
  status: FiscalDocumentStatus.ACCEPTED,
  attempts: 1,
  rejectionReason: null as string | null
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

  it('makes a voided sale document again once, and a voided credit note again, never one that is not voided or has its replacement', () => {
    const voided = { ...base, status: FiscalDocumentStatus.VOIDED }
    expect(fiscalActionsOf(voided, none).replace).toBe(true)
    expect(fiscalActionsOf(voided, new Set(['d1'])).replace).toBe(false)
    // A credit note is made again from its return: the api says if it already was (`note_already_replaced`)
    expect(fiscalActionsOf({ ...voided, kind: FiscalDocumentKind.CREDIT_NOTE }, none).replace).toBe(
      true
    )
    for (const status of Object.values(FiscalDocumentStatus)) {
      if (status === FiscalDocumentStatus.VOIDED) continue
      for (const kind of Object.values(FiscalDocumentKind)) {
        expect(fiscalActionsOf({ ...base, status, kind }, none).replace).toBe(false)
      }
    }
  })

  it('confirms an issuer change only on a refused document that was sent and was refused because the issuer changed', () => {
    const moved = {
      ...base,
      status: FiscalDocumentStatus.REJECTED,
      rejectionReason: FiscalRejectionReasons.ISSUER_CHANGED
    }
    expect(fiscalActionsOf(moved, none).confirmIssuerChange).toBe(true)
    expect(fiscalActionsOf({ ...moved, attempts: 0 }, none).confirmIssuerChange).toBe(false)
    expect(fiscalActionsOf({ ...moved, rejectionReason: 'x' }, none).confirmIssuerChange).toBe(
      false
    )
    expect(fiscalActionsOf({ ...moved, rejectionReason: null }, none).confirmIssuerChange).toBe(
      false
    )
    expect(
      fiscalActionsOf({ ...moved, status: FiscalDocumentStatus.QUEUED }, none).confirmIssuerChange
    ).toBe(false)
  })

  it('offers the files of evidence the api makes: two once accepted, three once voided, none before', () => {
    const kinds = (status: FiscalDocumentStatus) => fiscalEvidenceKindsOf({ status })
    expect(kinds(FiscalDocumentStatus.ACCEPTED)).toEqual([
      FiscalEvidenceKind.DOCUMENT,
      FiscalEvidenceKind.RESPONSE
    ])
    expect(kinds(FiscalDocumentStatus.VOIDED)).toEqual([
      FiscalEvidenceKind.DOCUMENT,
      FiscalEvidenceKind.RESPONSE,
      FiscalEvidenceKind.VOID_RESPONSE
    ])
    for (const status of Object.values(FiscalDocumentStatus)) {
      if (status === FiscalDocumentStatus.ACCEPTED || status === FiscalDocumentStatus.VOIDED) {
        continue
      }
      expect(kinds(status)).toEqual([])
    }
  })

  it('knows the refusal that asks for the confirmation of an issuer change', () => {
    expect(isIssuerChangedInFlight(FiscalConflictReasons.ISSUER_CHANGED_IN_FLIGHT)).toBe(true)
    expect(isIssuerChangedInFlight(FiscalConflictReasons.NO_ISSUER_CHANGE)).toBe(false)
    expect(isIssuerChangedInFlight(null)).toBe(false)
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

describe('the replacement made before the invalidation', () => {
  const accepted = { ...base, status: FiscalDocumentStatus.ACCEPTED }
  const none: ReadonlySet<string> = new Set()

  it('is offered for an accepted sale document only when the provider asks for it, and once', () => {
    expect(fiscalActionsOf(accepted, none, true).replaceFirst).toBe(true)
    expect(fiscalActionsOf(accepted, none, false).replaceFirst).toBe(false)
    expect(fiscalActionsOf(accepted, none).replaceFirst).toBe(false)
    expect(fiscalActionsOf(accepted, new Set([accepted.id]), true).replaceFirst).toBe(false)
  })

  it('is not offered for a document that is itself a replacement', () => {
    expect(
      fiscalActionsOf({ ...accepted, replacesDocumentId: 'original' }, none, true).replaceFirst
    ).toBe(false)
  })

  it('is not offered for a credit note or for a document that is not accepted', () => {
    expect(
      fiscalActionsOf({ ...accepted, kind: FiscalDocumentKind.CREDIT_NOTE }, none, true)
        .replaceFirst
    ).toBe(false)
    for (const status of Object.values(FiscalDocumentStatus)) {
      if (status === FiscalDocumentStatus.ACCEPTED) continue
      expect(fiscalActionsOf({ ...base, status }, none, true).replaceFirst).toBe(false)
    }
  })

  it('leaves the other actions as they were', () => {
    const actions = fiscalActionsOf(accepted, none, true)
    expect(actions.void).toBe(true)
    expect(actions.replace).toBe(false)
  })
})
