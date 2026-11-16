import type { FiscalDocumentView } from '@platform/api-client'
import {
  FiscalConflictReasons,
  FiscalDocumentKind,
  FiscalDocumentStatus,
  FiscalEvidenceKind,
  FiscalLimits,
  FiscalRejectionReasons
} from '@platform/core/domain'

// What a person may do with a fiscal document, read from the state the api sent. They mirror the rules of the api (`fiscal-rules.ts` of
// the runtime), which decides again on every call: a button that is shown here only saves a refused request. The web does not import the
// runtime, so the rules are written here once and a spec holds them to the states of the lifecycle.

export interface FiscalDocumentActions {
  // The receiver of a sale document that was refused or never sent: a credit note's receiver is its sale document's
  editReceiver: boolean
  // Sent again from a refusal, or from the queue when the job was lost
  retry: boolean
  // The invalidation of an accepted document: irreversible
  void: boolean
  // A voided sale document that has no replacement among the documents the person has loaded, or a voided credit note (its replacement is
  // the note of its return, which the web cannot see: the api refuses with `note_already_replaced`)
  replace: boolean
  // A refused document that was sent at least once and whose refusal is that the issuer changed: the person says it is not at the old issuer
  confirmIssuerChange: boolean
}

export function fiscalActionsOf(
  document: Pick<FiscalDocumentView, 'id' | 'kind' | 'status' | 'attempts' | 'rejectionReason'>,
  replacedIds: ReadonlySet<string>
): FiscalDocumentActions {
  const sale = document.kind === FiscalDocumentKind.SALE
  const refused = document.status === FiscalDocumentStatus.REJECTED
  const queued = document.status === FiscalDocumentStatus.QUEUED
  return {
    editReceiver: sale && (refused || (queued && document.attempts === 0)),
    retry: refused || queued,
    void: document.status === FiscalDocumentStatus.ACCEPTED,
    replace:
      document.status === FiscalDocumentStatus.VOIDED &&
      (sale ? !replacedIds.has(document.id) : true),
    confirmIssuerChange:
      refused &&
      document.attempts > 0 &&
      document.rejectionReason === FiscalRejectionReasons.ISSUER_CHANGED
  }
}

// The ids of the voided documents that a document of the list replaces: a voided one is replaced once
export const replacedIdsOf = (documents: readonly FiscalDocumentView[]): Set<string> =>
  new Set(
    documents.flatMap(document =>
      document.replacesDocumentId === null ? [] : [document.replacesDocumentId]
    )
  )

// What needs a person's attention: a refusal, or a document that stays in the queue after every attempt of its job was spent
export const FiscalAttention = { REJECTED: 'rejected', STUCK: 'stuck' } as const
export type FiscalAttentionKind = (typeof FiscalAttention)[keyof typeof FiscalAttention]

export function fiscalAttentionOf(
  document: Pick<FiscalDocumentView, 'status' | 'attempts'>
): FiscalAttentionKind | null {
  if (document.status === FiscalDocumentStatus.REJECTED) return FiscalAttention.REJECTED
  if (
    document.status === FiscalDocumentStatus.QUEUED &&
    document.attempts >= FiscalLimits.MAX_ATTEMPTS
  ) {
    return FiscalAttention.STUCK
  }
  return null
}

const CORE_REJECTIONS: readonly string[] = Object.values(FiscalRejectionReasons)

// The reason core itself gave for a refusal has its own words; one a provider gave is its own code, shown as it came
export const coreRejectionOf = (reason: string | null): string | null =>
  reason !== null && CORE_REJECTIONS.includes(reason) ? reason : null

const CONFLICTS: readonly string[] = Object.values(FiscalConflictReasons)

// The `reason` the api gives with a refused action, when it is one the screen has words for
export const conflictReasonOf = (value: unknown): string | null =>
  typeof value === 'string' && CONFLICTS.includes(value) ? value : null

// The files of evidence a document has, by its state (the api makes them when the document is accepted or voided: what was built and the
// authority's answer to the acceptance from then on, its answer to the invalidation once it is voided)
export const fiscalEvidenceKindsOf = (
  document: Pick<FiscalDocumentView, 'status'>
): readonly FiscalEvidenceKind[] => {
  if (document.status === FiscalDocumentStatus.VOIDED) {
    return [
      FiscalEvidenceKind.DOCUMENT,
      FiscalEvidenceKind.RESPONSE,
      FiscalEvidenceKind.VOID_RESPONSE
    ]
  }
  return document.status === FiscalDocumentStatus.ACCEPTED
    ? [FiscalEvidenceKind.DOCUMENT, FiscalEvidenceKind.RESPONSE]
    : []
}

// Whether a refusal of `retry` is the one that asks for the person's confirmation of an issuer change
export const isIssuerChangedInFlight = (reason: string | null): boolean =>
  reason === FiscalConflictReasons.ISSUER_CHANGED_IN_FLIGHT
