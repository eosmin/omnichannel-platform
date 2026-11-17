import {
  FiscalContingencyReportOutcome,
  FiscalDeferOutcome,
  FiscalSubmitOutcome
} from '@platform/core/domain'

import type {
  BuiltDocument,
  FiscalBuildInput,
  FiscalContingencyEvent,
  FiscalCreditedDocument,
  FiscalDocumentProvider,
  FiscalIssuerInput,
  FiscalVoidDetails,
  ProviderContext,
  StoredFiscalDocument,
  SubmitResult
} from './fiscal-provider.interface'

// The conformance run: the minimum set of documents an authority asks of an issuer before it authorizes it, made and sent through the port of
// a provider (never through the lifecycle of core, which needs a database). A plan is a list of steps that a provider package builds with
// its own data; this runs it against any provider, the simulator by default and the real sandbox only where its owner says so, and says
// what happened in a report that carries no document, no number and no secret: ids of the plan, kinds, outcomes and codes.

export type ConformanceStep =
  // The document of a sale, made and sent
  | {
      readonly kind: 'sale'
      readonly id: string
      readonly tags: readonly string[]
      // The part of the minimum this document counts toward (the documents made for an invalidation or a contingency count toward none)
      readonly bucket: string | null
      readonly input: FiscalBuildInput
    }
  // A credit note of a document of the plan (its `credited` is filled in from what the provider accepted)
  | {
      readonly kind: 'credit_note'
      readonly id: string
      readonly tags: readonly string[]
      readonly bucket: string | null
      readonly parent: string
      readonly input: FiscalBuildInput
    }
  // The invalidation of an accepted document of the plan, and the document of the plan that takes its place when the reason names one
  | {
      readonly kind: 'void'
      readonly id: string
      readonly tags: readonly string[]
      readonly target: string
      readonly reason: string
      readonly details: Omit<FiscalVoidDetails, 'replacement'>
      readonly replacement: string | null
    }
  // A document made in contingency: built, signed and kept, not sent until the event that lists it is taken
  | {
      readonly kind: 'deferred_sale'
      readonly id: string
      readonly tags: readonly string[]
      readonly input: FiscalBuildInput
    }
  // The event that reports a contingency, with the deferred documents of the plan it lists; once taken, they are sent
  | {
      readonly kind: 'contingency'
      readonly id: string
      readonly tags: readonly string[]
      readonly documents: readonly string[]
      readonly event: Omit<FiscalContingencyEvent, 'documents'>
    }

export enum ConformanceOutcome {
  ACCEPTED = 'accepted',
  REJECTED = 'rejected',
  UNAVAILABLE = 'unavailable',
  // The provider refused before it sent anything (a credential, an incomplete document)
  NOT_SENT = 'not_sent',
  BUILD_FAILED = 'build_failed',
  DRY_RUN_BUILT = 'dry_run_built',
  VOIDED = 'voided',
  VOID_REFUSED = 'void_refused',
  DEFERRED = 'deferred',
  DEFER_REFUSED = 'defer_refused',
  REPORTED = 'reported',
  REPORT_REFUSED = 'report_refused',
  SKIPPED = 'skipped',
  ERROR = 'error'
}

export const ConformanceCodes = {
  DRY_RUN: 'dry_run',
  NO_CONTINGENCY_MODE: 'no_contingency_mode',
  PARENT_MISSING: 'parent_missing',
  TARGET_MISSING: 'target_missing',
  REPLACEMENT_MISSING: 'replacement_missing',
  DOCUMENT_MISSING: 'document_missing',
  RECEIVER_INCOMPLETE: 'receiver_incomplete',
  UNREADABLE: 'unreadable',
  NO_ANSWER: 'no_answer'
} as const

export interface ConformanceStepResult {
  readonly id: string
  readonly kind: ConformanceStep['kind']
  // The provider's own id of the document type, when the document was built
  readonly documentType: string | null
  readonly outcome: ConformanceOutcome
  // A code (of the provider, of the authority or of this run), never free text
  readonly code: string | null
}

export interface ConformanceDocumentTotals {
  planned: number
  built: number
  accepted: number
  rejected: number
  unavailable: number
  notSent: number
  failed: number
}

export interface ConformanceReport {
  readonly mode: 'dry_run' | 'live'
  readonly batch: string
  readonly documents: Record<string, ConformanceDocumentTotals>
  // Documents of a kind no type was known for (built nothing): by kind of step
  readonly unbuilt: Record<string, number>
  // What counts toward the minimum the authority asks, by bucket of the plan: only the documents the plan made for it, accepted
  readonly minimum: Record<string, { planned: number; accepted: number }>
  readonly voids: { planned: number; done: number; refused: number }
  readonly contingencies: {
    planned: number
    reported: number
    refused: number
    deferred: number
    deferredAccepted: number
  }
  // How varied the plan was: how many steps carry each tag and how many of them were accepted (or built, in a dry run)
  readonly tags: Record<string, { planned: number; succeeded: number }>
  // The codes of every refusal, counted
  readonly codes: Record<string, number>
  readonly steps: readonly ConformanceStepResult[]
}

export interface ConformanceOptions {
  readonly provider: FiscalDocumentProvider
  readonly issuer: FiscalIssuerInput
  readonly credentials: Readonly<Record<string, unknown>>
  // Told apart from another run of the same plan: it is part of the idempotency key of each step
  readonly batch: string
  // Builds everything and sends nothing
  readonly dryRun: boolean
  // Values that must never appear in the report (passwords, a tax id, a token): the run fails if one does
  readonly secrets?: readonly string[]
  // A dry run has no accepted parent for a credit note: the provider package says what the note names
  readonly dryRunCredited?: (
    built: BuiltDocument,
    input: FiscalBuildInput
  ) => FiscalCreditedDocument | null
}

// What a run that found a secret in its own report can still say: numbers only (they cannot carry a secret), so the person who ran it
// knows what was sent and does not send it again
export interface ConformanceCounts {
  readonly steps: number
  readonly accepted: number
  readonly refused: number
  readonly unavailable: number
  readonly voided: number
  readonly contingenciesReported: number
}

export class ConformanceLeakError extends Error {
  constructor(readonly counts: ConformanceCounts) {
    // Never says which value or where: a message is the first thing a log keeps
    super('the report of the conformance run carries a value that must stay secret')
    this.name = 'ConformanceLeakError'
  }
}

// What a provider or an authority gives as the reason of a refusal is a code of a shape: free text may carry data and is not kept
const CODE_SHAPE = /^[A-Za-z0-9_.:-]{1,60}$/
export const safeCode = (value: unknown): string =>
  typeof value === 'string' && CODE_SHAPE.test(value) ? value : ConformanceCodes.UNREADABLE

const emptyTotals = (): ConformanceDocumentTotals => ({
  planned: 0,
  built: 0,
  accepted: 0,
  rejected: 0,
  unavailable: 0,
  notSent: 0,
  failed: 0
})

interface Held {
  readonly input: FiscalBuildInput
  readonly built: BuiltDocument
  // Set when the authority accepted it
  accepted: {
    externalNumber: string
    providerData: Readonly<Record<string, unknown>> | null
  } | null
  // Set when it was made in contingency and kept
  deferred: boolean
}

export async function runConformance(
  steps: readonly ConformanceStep[],
  options: ConformanceOptions
): Promise<ConformanceReport> {
  const held = new Map<string, Held>()
  const results: ConformanceStepResult[] = []
  const documents: Record<string, ConformanceDocumentTotals> = {}
  const unbuilt: Record<string, number> = {}
  const tags: Record<string, { planned: number; succeeded: number }> = {}
  const codes: Record<string, number> = {}
  const minimum: Record<string, { planned: number; accepted: number }> = {}
  const voids = { planned: 0, done: 0, refused: 0 }
  const contingencies = { planned: 0, reported: 0, refused: 0, deferred: 0, deferredAccepted: 0 }
  const mode = options.dryRun ? ('dry_run' as const) : ('live' as const)
  const canDefer =
    options.provider.manifest.contingencyMode !== undefined &&
    options.provider.deferDocument !== undefined &&
    options.provider.reportContingency !== undefined

  const contextOf = (id: string): ProviderContext => ({
    issuer: options.issuer,
    credentials: options.credentials,
    idempotencyKey: `conformance:${options.batch}:${id}`,
    attempt: 1
  })
  const totalsOf = (type: string): ConformanceDocumentTotals => (documents[type] ??= emptyTotals())
  const record = (
    step: ConformanceStep,
    documentType: string | null,
    outcome: ConformanceOutcome,
    code: string | null,
    succeeded: boolean
  ): void => {
    results.push({ id: step.id, kind: step.kind, documentType, outcome, code })
    if (code !== null) codes[code] = (codes[code] ?? 0) + 1
    for (const tag of step.tags) {
      const entry = (tags[tag] ??= { planned: 0, succeeded: 0 })
      entry.planned += 1
      if (succeeded) entry.succeeded += 1
    }
  }
  // What a call to a provider throws may carry the data of a document: only its name is kept
  const errorCode = (error: unknown): string =>
    safeCode(`error:${error instanceof Error ? error.name : 'unknown'}`)

  const build = async (
    input: FiscalBuildInput
  ): Promise<
    { ok: true; built: BuiltDocument } | { ok: false; outcome: ConformanceOutcome; code: string }
  > => {
    try {
      const built = await options.provider.build(input)
      if (built.missingReceiverFields.length > 0) {
        return {
          ok: false,
          outcome: ConformanceOutcome.BUILD_FAILED,
          code: ConformanceCodes.RECEIVER_INCOMPLETE
        }
      }
      return { ok: true, built }
    } catch (error) {
      // A provider refuses what it cannot make right with a code: its own error carries only that
      const code =
        error instanceof Error && CODE_SHAPE.test(error.message) ? error.message : errorCode(error)
      return { ok: false, outcome: ConformanceOutcome.BUILD_FAILED, code }
    }
  }

  for (const step of steps) {
    try {
      if (step.kind === 'sale' || step.kind === 'deferred_sale' || step.kind === 'credit_note') {
        let input = step.input
        if (step.kind === 'credit_note') {
          const parent = held.get(step.parent)
          let credited: FiscalCreditedDocument | null = null
          if (parent !== undefined && parent.accepted !== null) {
            credited = {
              documentType: parent.built.documentType,
              externalNumber: parent.accepted.externalNumber,
              issuedAt: parent.input.issuedAt,
              providerData: parent.accepted.providerData
            }
          } else if (options.dryRun && parent !== undefined) {
            credited = options.dryRunCredited?.(parent.built, parent.input) ?? null
          }
          if (credited === null) {
            record(step, null, ConformanceOutcome.SKIPPED, ConformanceCodes.PARENT_MISSING, false)
            unbuilt[step.kind] = (unbuilt[step.kind] ?? 0) + 1
            continue
          }
          input = { ...step.input, credited }
        }
        if (step.kind === 'deferred_sale' && !canDefer) {
          record(
            step,
            null,
            ConformanceOutcome.SKIPPED,
            ConformanceCodes.NO_CONTINGENCY_MODE,
            false
          )
          unbuilt[step.kind] = (unbuilt[step.kind] ?? 0) + 1
          continue
        }
        const made = await build(input)
        if (!made.ok) {
          record(step, null, made.outcome, made.code, false)
          unbuilt[step.kind] = (unbuilt[step.kind] ?? 0) + 1
          continue
        }
        const type = made.built.documentType
        const totals = totalsOf(type)
        totals.planned += 1
        totals.built += 1
        if (step.kind !== 'deferred_sale' && step.bucket !== null) {
          const part = (minimum[step.bucket] ??= { planned: 0, accepted: 0 })
          part.planned += 1
        }
        const entry: Held = { input, built: made.built, accepted: null, deferred: false }
        held.set(step.id, entry)
        if (options.dryRun) {
          record(step, type, ConformanceOutcome.DRY_RUN_BUILT, null, true)
          continue
        }
        if (step.kind === 'deferred_sale') {
          const deferred = await options.provider.deferDocument?.(made.built, contextOf(step.id))
          if (deferred?.outcome === FiscalDeferOutcome.DEFERRED) {
            entry.deferred = true
            contingencies.deferred += 1
            record(step, type, ConformanceOutcome.DEFERRED, null, true)
          } else {
            totals.failed += 1
            record(
              step,
              type,
              deferred?.outcome === FiscalDeferOutcome.REJECTED
                ? ConformanceOutcome.DEFER_REFUSED
                : ConformanceOutcome.UNAVAILABLE,
              deferred?.outcome === FiscalDeferOutcome.REJECTED
                ? safeCode(deferred.reason)
                : ConformanceCodes.NO_ANSWER,
              false
            )
          }
          continue
        }
        const sent = await options.provider.submit(made.built, contextOf(step.id))
        if (sent.outcome === FiscalSubmitOutcome.ACCEPTED) {
          entry.accepted = {
            externalNumber: sent.externalNumber,
            providerData: sent.providerData ?? null
          }
          totals.accepted += 1
          if (step.bucket !== null) {
            const part = (minimum[step.bucket] ??= { planned: 0, accepted: 0 })
            part.accepted += 1
          }
          record(step, type, ConformanceOutcome.ACCEPTED, null, true)
        } else if (sent.outcome === FiscalSubmitOutcome.REJECTED) {
          if (sent.neverSent === true) {
            totals.notSent += 1
            record(step, type, ConformanceOutcome.NOT_SENT, safeCode(sent.reason), false)
          } else {
            totals.rejected += 1
            record(step, type, ConformanceOutcome.REJECTED, safeCode(sent.reason), false)
          }
        } else {
          totals.unavailable += 1
          record(step, type, ConformanceOutcome.UNAVAILABLE, ConformanceCodes.NO_ANSWER, false)
        }
        continue
      }

      if (step.kind === 'void') {
        voids.planned += 1
        const target = held.get(step.target)
        const replacement = step.replacement === null ? null : held.get(step.replacement)
        if (options.dryRun) {
          record(step, null, ConformanceOutcome.SKIPPED, ConformanceCodes.DRY_RUN, false)
          continue
        }
        if (target === undefined || target.accepted === null) {
          voids.refused += 1
          record(step, null, ConformanceOutcome.SKIPPED, ConformanceCodes.TARGET_MISSING, false)
          continue
        }
        if (step.replacement !== null && replacement?.accepted == null) {
          voids.refused += 1
          record(
            step,
            null,
            ConformanceOutcome.SKIPPED,
            ConformanceCodes.REPLACEMENT_MISSING,
            false
          )
          continue
        }
        const stored = (doc: Held): StoredFiscalDocument => ({
          documentType: doc.built.documentType,
          externalNumber: doc.accepted?.externalNumber ?? null,
          providerData: doc.accepted?.providerData ?? null,
          payload: doc.built.payload
        })
        const details: FiscalVoidDetails = {
          ...step.details,
          ...(replacement == null ? {} : { replacement: stored(replacement) })
        }
        const result = await options.provider.void(
          stored(target),
          step.reason,
          contextOf(step.id),
          details
        )
        if (result.voided) {
          voids.done += 1
          record(step, target.built.documentType, ConformanceOutcome.VOIDED, null, true)
        } else {
          voids.refused += 1
          record(
            step,
            target.built.documentType,
            ConformanceOutcome.VOID_REFUSED,
            safeCode(result.reason),
            false
          )
        }
        continue
      }

      // The report of a contingency
      contingencies.planned += 1
      if (options.dryRun) {
        record(step, null, ConformanceOutcome.SKIPPED, ConformanceCodes.DRY_RUN, false)
        continue
      }
      if (!canDefer) {
        record(step, null, ConformanceOutcome.SKIPPED, ConformanceCodes.NO_CONTINGENCY_MODE, false)
        continue
      }
      const listed = step.documents.map(id => held.get(id))
      const kept = listed.filter((doc): doc is Held => doc !== undefined && doc.deferred)
      if (kept.length === 0 || kept.length !== listed.length) {
        contingencies.refused += 1
        record(step, null, ConformanceOutcome.SKIPPED, ConformanceCodes.DOCUMENT_MISSING, false)
        continue
      }
      const reported = await options.provider.reportContingency?.(
        {
          ...step.event,
          documents: kept.map(doc => ({
            documentType: doc.built.documentType,
            externalNumber: null,
            providerData: null,
            payload: doc.built.payload
          }))
        },
        contextOf(step.id)
      )
      if (reported?.outcome !== FiscalContingencyReportOutcome.ACCEPTED) {
        contingencies.refused += 1
        record(
          step,
          null,
          reported?.outcome === FiscalContingencyReportOutcome.REJECTED
            ? ConformanceOutcome.REPORT_REFUSED
            : ConformanceOutcome.UNAVAILABLE,
          reported?.outcome === FiscalContingencyReportOutcome.REJECTED
            ? safeCode(reported.reason)
            : ConformanceCodes.NO_ANSWER,
          false
        )
        continue
      }
      contingencies.reported += 1
      record(step, null, ConformanceOutcome.REPORTED, null, true)
      // The event was taken: the documents of the lot go out
      for (const id of step.documents) {
        const doc = held.get(id)
        if (doc === undefined) continue
        const totals = totalsOf(doc.built.documentType)
        let sent: SubmitResult
        try {
          sent = await options.provider.submit(doc.built, contextOf(id))
        } catch (error) {
          // One document that breaks does not leave the rest of the lot unsent; it is a failure of its own
          totals.failed += 1
          const code = errorCode(error)
          codes[code] = (codes[code] ?? 0) + 1
          results.push({
            id,
            kind: 'deferred_sale',
            documentType: doc.built.documentType,
            outcome: ConformanceOutcome.ERROR,
            code
          })
          continue
        }
        if (sent.outcome === FiscalSubmitOutcome.ACCEPTED) {
          doc.accepted = {
            externalNumber: sent.externalNumber,
            providerData: sent.providerData ?? null
          }
          totals.accepted += 1
          contingencies.deferredAccepted += 1
          results.push({
            id,
            kind: 'deferred_sale',
            documentType: doc.built.documentType,
            outcome: ConformanceOutcome.ACCEPTED,
            code: null
          })
        } else {
          const code =
            sent.outcome === FiscalSubmitOutcome.REJECTED
              ? safeCode(sent.reason)
              : ConformanceCodes.NO_ANSWER
          if (sent.outcome === FiscalSubmitOutcome.REJECTED) totals.rejected += 1
          else totals.unavailable += 1
          codes[code] = (codes[code] ?? 0) + 1
          results.push({
            id,
            kind: 'deferred_sale',
            documentType: doc.built.documentType,
            outcome:
              sent.outcome === FiscalSubmitOutcome.REJECTED
                ? ConformanceOutcome.REJECTED
                : ConformanceOutcome.UNAVAILABLE,
            code
          })
        }
      }
    } catch (error) {
      record(step, null, ConformanceOutcome.ERROR, errorCode(error), false)
    }
  }

  const report: ConformanceReport = {
    mode,
    batch: options.batch,
    documents,
    unbuilt,
    minimum,
    voids,
    contingencies,
    tags,
    codes,
    steps: results
  }
  assertNoSecrets(report, options.secrets ?? [])
  return report
}

// The last gate before a report leaves this module: none of the values that must stay secret may be anywhere in it, as typed or as JSON
// writes it (a quote or a backslash is escaped there). Short values are not searched (a two-digit code would be "found" in any number):
// a secret is long. A leak fails the run, with the numbers of what was done and nothing else.
const SECRET_MIN_LENGTH = 4
export function assertNoSecrets(report: unknown, secrets: readonly string[]): void {
  const text = JSON.stringify(report)
  for (const secret of secrets) {
    if (secret.length < SECRET_MIN_LENGTH) continue
    if (text.includes(secret) || text.includes(JSON.stringify(secret).slice(1, -1))) {
      throw new ConformanceLeakError(countsOf(report))
    }
  }
}

function countsOf(report: unknown): ConformanceCounts {
  const given = report as Partial<ConformanceReport>
  const totals = Object.values(given.documents ?? {})
  const sum = (pick: (totals: ConformanceDocumentTotals) => number): number =>
    totals.reduce((acc, one) => acc + pick(one), 0)
  const number = (value: unknown): number => (typeof value === 'number' ? value : 0)
  return {
    steps: given.steps?.length ?? 0,
    accepted: sum(one => one.accepted),
    refused: sum(one => one.rejected + one.notSent + one.failed),
    unavailable: sum(one => one.unavailable),
    voided: number(given.voids?.done),
    contingenciesReported: number(given.contingencies?.reported)
  }
}

export interface ConformanceTargets {
  // By bucket of the plan (what each document was made to count toward)
  readonly buckets: Readonly<Record<string, number>>
  readonly voids: number
  readonly contingencies: number
}

// Whether the report reaches what the authority asks: documents accepted for each bucket (the extra ones made for the invalidations and the
// contingencies never fill a bucket), invalidations done, contingencies reported
export function conformanceGaps(
  report: ConformanceReport,
  targets: ConformanceTargets
): { readonly ok: boolean; readonly missing: Record<string, number> } {
  const missing: Record<string, number> = {}
  for (const [bucket, wanted] of Object.entries(targets.buckets)) {
    const have = report.minimum[bucket]?.accepted ?? 0
    if (have < wanted) missing[bucket] = wanted - have
  }
  if (report.voids.done < targets.voids) missing['voids'] = targets.voids - report.voids.done
  if (report.contingencies.reported < targets.contingencies) {
    missing['contingencies'] = targets.contingencies - report.contingencies.reported
  }
  return { ok: Object.keys(missing).length === 0, missing }
}
