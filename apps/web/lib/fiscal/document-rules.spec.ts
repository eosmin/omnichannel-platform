import type { FiscalDeliveryView, FiscalDocumentView } from '@platform/api-client'
import {
  FiscalConflictReasons,
  FiscalDeliveryPending,
  FiscalDeliveryRoute,
  FiscalDeliveryStatus,
  FiscalDeliverySubject,
  FiscalDocumentKind,
  FiscalDocumentStatus,
  FiscalEvidenceKind,
  FiscalHandMeans,
  FiscalRejectionReasons
} from '@platform/core/domain'

import {
  conflictReasonOf,
  coreRejectionOf,
  fiscalActionsOf,
  FiscalAttention,
  fiscalAttentionOf,
  fiscalEvidenceKindsOf,
  handOverMeansOf,
  hasInvalidationToDeliver,
  isIssuerChangedInFlight,
  replacedIdsOf
} from './document-rules'

const base = {
  id: 'd1',
  kind: FiscalDocumentKind.SALE,
  status: FiscalDocumentStatus.ACCEPTED,
  attempts: 1,
  rejectionReason: null as string | null,
  replacesDocumentId: null as string | null
}
const none = new Set<string>()

describe('what a person may do with a fiscal document', () => {
  it('completes the receiver of a remission note, voids it, and makes a voided one again for its guide', () => {
    const note = { ...base, kind: FiscalDocumentKind.REMISSION_NOTE }
    expect(
      fiscalActionsOf({ ...note, status: FiscalDocumentStatus.REJECTED, attempts: 2 }, none)
    ).toMatchObject({ editReceiver: true, retry: true })
    expect(
      fiscalActionsOf({ ...note, status: FiscalDocumentStatus.QUEUED, attempts: 0 }, none)
        .editReceiver
    ).toBe(true)
    expect(fiscalActionsOf(note, none).void).toBe(true)
    const voided = { ...note, status: FiscalDocumentStatus.VOIDED }
    expect(fiscalActionsOf(voided, none).replace).toBe(true)
    // Not made first: that is only for the sale document
    expect(fiscalActionsOf(note, none, true).replaceFirst).toBe(false)
  })

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

  it('offers a voided document the files of the receiver only when the api says it has them (they are made while it is accepted)', () => {
    const voided = { status: FiscalDocumentStatus.VOIDED }
    const base = [
      FiscalEvidenceKind.DOCUMENT,
      FiscalEvidenceKind.RESPONSE,
      FiscalEvidenceKind.VOID_RESPONSE
    ]
    expect(fiscalEvidenceKindsOf(voided)).toEqual(base)
    expect(fiscalEvidenceKindsOf(voided, [])).toEqual(base)
    expect(fiscalEvidenceKindsOf(voided, [FiscalEvidenceKind.REPRESENTATION])).toEqual([
      ...base,
      FiscalEvidenceKind.REPRESENTATION
    ])
    expect(
      fiscalEvidenceKindsOf(voided, [
        FiscalEvidenceKind.REPRESENTATION,
        FiscalEvidenceKind.DTE_FILE
      ])
    ).toEqual([...base, FiscalEvidenceKind.DTE_FILE, FiscalEvidenceKind.REPRESENTATION])
  })

  it('shows the delivery of an invalidation only when the system recorded something or made files for it', () => {
    const view = (over: Partial<FiscalDeliveryView>): FiscalDeliveryView => ({
      documentId: 'd',
      subject: FiscalDeliverySubject.VOID,
      state: FiscalDeliveryPending,
      route: null,
      reason: null,
      means: null,
      handedOverAt: null,
      files: [FiscalEvidenceKind.VOID_RESPONSE],
      ...over
    })
    // A provider that draws no invalidation: nothing was recorded and no file was made, so nothing is owed or shown
    expect(hasInvalidationToDeliver(view({}))).toBe(false)
    expect(hasInvalidationToDeliver(view({ files: [FiscalEvidenceKind.VOID_DTE_FILE] }))).toBe(true)
    expect(
      hasInvalidationToDeliver(view({ files: [FiscalEvidenceKind.VOID_REPRESENTATION] }))
    ).toBe(true)
    expect(
      hasInvalidationToDeliver(
        view({ state: FiscalDeliveryStatus.NOT_SENT, route: FiscalDeliveryRoute.NONE })
      )
    ).toBe(true)
  })

  it('offers the invalidation its own means: the two files, the picture on paper, and the answer of the authority only when there is no file of ours', () => {
    const view = (files: FiscalEvidenceKind[], over: Partial<FiscalDeliveryView> = {}) => ({
      documentId: 'd',
      subject: FiscalDeliverySubject.VOID,
      state: FiscalDeliveryStatus.NOT_SENT,
      route: FiscalDeliveryRoute.NONE,
      reason: 'void_event_unavailable',
      means: null,
      handedOverAt: null,
      files,
      ...over
    })
    const voidFiles = [FiscalEvidenceKind.VOID_REPRESENTATION, FiscalEvidenceKind.VOID_DTE_FILE]
    expect(handOverMeansOf(view(voidFiles), true)).toEqual([
      FiscalHandMeans.DOWNLOAD,
      FiscalHandMeans.PAPER
    ])
    expect(handOverMeansOf(view([FiscalEvidenceKind.VOID_REPRESENTATION]), true)).toEqual([
      FiscalHandMeans.PAPER
    ])
    // No event of ours: the answer of the authority, as it is, and nothing is offered for a file that was never made
    expect(handOverMeansOf(view([FiscalEvidenceKind.VOID_RESPONSE]), true)).toEqual([
      FiscalHandMeans.ANSWER
    ])
    // With files of our own the answer is not what the customer is owed; the files of the document are not those of the invalidation
    expect(
      handOverMeansOf(view([...voidFiles, FiscalEvidenceKind.VOID_RESPONSE]), true)
    ).not.toContain(FiscalHandMeans.ANSWER)
    expect(
      handOverMeansOf(view([FiscalEvidenceKind.REPRESENTATION, FiscalEvidenceKind.DTE_FILE]), true)
    ).toEqual([])
    expect(handOverMeansOf(view([FiscalEvidenceKind.VOID_RESPONSE]), false)).toEqual([])
    expect(
      handOverMeansOf(
        view([FiscalEvidenceKind.VOID_RESPONSE], { state: FiscalDeliveryStatus.SENT }),
        true
      )
    ).toEqual([])
  })

  it('offers a voided document the files of its invalidation only when the api says they exist, and never to a document that is not voided', () => {
    const voided = { status: FiscalDocumentStatus.VOIDED }
    const base = [
      FiscalEvidenceKind.DOCUMENT,
      FiscalEvidenceKind.RESPONSE,
      FiscalEvidenceKind.VOID_RESPONSE
    ]
    expect(fiscalEvidenceKindsOf(voided, [FiscalEvidenceKind.DTE_FILE])).toEqual([
      ...base,
      FiscalEvidenceKind.DTE_FILE
    ])
    expect(
      fiscalEvidenceKindsOf(voided, [
        FiscalEvidenceKind.VOID_REPRESENTATION,
        FiscalEvidenceKind.VOID_DTE_FILE
      ])
    ).toEqual([...base, FiscalEvidenceKind.VOID_DTE_FILE, FiscalEvidenceKind.VOID_REPRESENTATION])
    const all = Object.values(FiscalEvidenceKind)
    for (const status of [FiscalDocumentStatus.ACCEPTED, FiscalDocumentStatus.QUEUED]) {
      expect(fiscalEvidenceKindsOf({ status }, all)).not.toContain(FiscalEvidenceKind.VOID_DTE_FILE)
      expect(fiscalEvidenceKindsOf({ status }, all)).not.toContain(
        FiscalEvidenceKind.VOID_REPRESENTATION
      )
    }
  })

  it('offers the hand delivery only while the files are owed and exist: the files need both, the paper the picture alone', () => {
    const view = (over: Partial<FiscalDeliveryView>): FiscalDeliveryView => ({
      documentId: 'd',
      subject: FiscalDeliverySubject.DOCUMENT,
      state: FiscalDeliveryStatus.NOT_SENT,
      route: FiscalDeliveryRoute.NONE,
      reason: 'no_channel',
      means: null,
      handedOverAt: null,
      files: [FiscalEvidenceKind.REPRESENTATION, FiscalEvidenceKind.DTE_FILE],
      ...over
    })
    const both = [FiscalHandMeans.DOWNLOAD, FiscalHandMeans.PAPER]
    expect(handOverMeansOf(view({}), true)).toEqual(both)
    expect(
      handOverMeansOf(view({ state: FiscalDeliveryPending, route: null, reason: null }), true)
    ).toEqual(both)
    expect(handOverMeansOf(view({ files: [FiscalEvidenceKind.REPRESENTATION] }), true)).toEqual([
      FiscalHandMeans.PAPER
    ])
    expect(handOverMeansOf(view({ files: [FiscalEvidenceKind.DTE_FILE] }), true)).toEqual([])
    expect(
      handOverMeansOf(
        view({ state: FiscalDeliveryStatus.SENT, route: FiscalDeliveryRoute.EMAIL }),
        true
      )
    ).toEqual([])
    expect(
      handOverMeansOf(
        view({ state: FiscalDeliveryStatus.SENT, route: FiscalDeliveryRoute.MANUAL }),
        true
      )
    ).toEqual([])
    expect(handOverMeansOf(view({ files: [] }), true)).toEqual([])
    expect(handOverMeansOf(view({}), false)).toEqual([])
  })

  it('offers the files of evidence the api makes: four once accepted, three once voided with none of the receiver, none before', () => {
    const kinds = (status: FiscalDocumentStatus) => fiscalEvidenceKindsOf({ status })
    expect(kinds(FiscalDocumentStatus.ACCEPTED)).toEqual([
      FiscalEvidenceKind.DOCUMENT,
      FiscalEvidenceKind.RESPONSE,
      FiscalEvidenceKind.DTE_FILE,
      FiscalEvidenceKind.REPRESENTATION
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
  it('flags a refusal, and a queued document the server says is stuck', () => {
    expect(fiscalAttentionOf({ status: FiscalDocumentStatus.REJECTED, stuck: false })).toBe(
      FiscalAttention.REJECTED
    )
    expect(fiscalAttentionOf({ status: FiscalDocumentStatus.QUEUED, stuck: true })).toBe(
      FiscalAttention.STUCK
    )
    // One that is still retrying (a released document keeps asking for its whole window) is not stuck, however many attempts it has
    expect(fiscalAttentionOf({ status: FiscalDocumentStatus.QUEUED, stuck: false })).toBeNull()
    expect(fiscalAttentionOf({ status: FiscalDocumentStatus.ACCEPTED, stuck: false })).toBeNull()
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
