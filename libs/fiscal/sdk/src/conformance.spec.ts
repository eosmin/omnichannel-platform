import {
  FiscalContingencyReportOutcome,
  FiscalDeferOutcome,
  FiscalDocumentKind,
  FiscalEnvironment,
  FiscalOperationCondition,
  FiscalSubmitOutcome
} from '@platform/core/domain'

import {
  assertNoSecrets,
  ConformanceLeakError,
  ConformanceOutcome,
  conformanceGaps,
  runConformance,
  safeCode,
  type ConformanceStep
} from './conformance'
import type {
  FiscalBuildInput,
  FiscalDocumentProvider,
  FiscalIssuerInput,
  SubmitResult
} from './fiscal-provider.interface'

// The runner against a provider made for the spec: what it does with each step, what it keeps out of its report and what it counts.

const ISSUER: FiscalIssuerInput = {
  legalName: 'Emisor de Prueba',
  taxId: 'ISSUER-SECRET-1234',
  registrationId: null,
  address: {},
  activityCode: null,
  establishmentCode: null,
  establishmentType: null,
  pointOfSaleCode: null,
  phone: null,
  email: null,
  environment: FiscalEnvironment.SANDBOX
}

const input = (n: number, over: Partial<FiscalBuildInput> = {}): FiscalBuildInput => ({
  kind: FiscalDocumentKind.SALE,
  credited: null,
  sequenceNumber: n,
  correlative: n,
  documentUuid: `doc-${n}`,
  issuedAt: '2026-11-17T10:00:00.000Z',
  orderNumber: `ORD-${n}`,
  currency: 'USD',
  issuer: ISSUER,
  receiver: {
    name: null,
    taxId: null,
    registrationId: null,
    address: null,
    email: null,
    phone: null
  },
  lines: [],
  shippingCents: 0,
  shippingTaxCents: 0,
  discountCents: 0,
  totalCents: 0,
  taxCents: 0,
  pricesIncludeTax: true,
  payments: [],
  condition: FiscalOperationCondition.IMMEDIATE,
  ...over
})

interface Script {
  // What submit answers to a document, by its generation code
  submit?: (built: { payload: Record<string, unknown> }) => SubmitResult
  buildThrows?: (n: number) => Error | null
  documentType?: string
  contingency?: boolean
  voidAnswer?: { voided: boolean; reason?: string }
  report?: FiscalContingencyReportOutcome
}

function provider(script: Script = {}): FiscalDocumentProvider & { sent: string[] } {
  const sent: string[] = []
  const base: FiscalDocumentProvider = {
    id: 'scripted',
    countryCode: 'XX',
    manifest: {
      documentTypes: [],
      requiredIssuerFields: [],
      credentialKeys: [],
      environments: [FiscalEnvironment.SANDBOX],
      ...(script.contingency === true
        ? {
            contingencyMode: {
              reasons: ['1'],
              authorityDownReason: '1',
              transmitWithinHours: 72,
              maxDocumentsPerEvent: 100,
              requiresResponsible: false
            }
          }
        : {})
    },
    validateIssuer: () => Promise.resolve({ ok: true, problems: [] }),
    build: built => {
      const error = script.buildThrows?.(built.correlative) ?? null
      if (error !== null) return Promise.reject(error)
      return Promise.resolve({
        documentType: script.documentType ?? 'T1',
        payload: { id: built.documentUuid, kind: built.kind, credits: built.credited },
        missingReceiverFields: []
      })
    },
    submit: built => {
      sent.push(String(built.payload['id']))
      return Promise.resolve(
        script.submit?.(built) ?? {
          outcome: FiscalSubmitOutcome.ACCEPTED,
          externalNumber: `EXT-${String(built.payload['id'])}`
        }
      )
    },
    consult: () => Promise.reject(new Error('not used')),
    void: () => Promise.resolve(script.voidAnswer ?? { voided: true }),
    ...(script.contingency === true
      ? {
          deferDocument: () => Promise.resolve({ outcome: FiscalDeferOutcome.DEFERRED as const }),
          reportContingency: () =>
            Promise.resolve(
              (script.report ?? FiscalContingencyReportOutcome.ACCEPTED) ===
                FiscalContingencyReportOutcome.ACCEPTED
                ? {
                    outcome: FiscalContingencyReportOutcome.ACCEPTED as const,
                    receivedAt: '2026-11-17T10:00:00.000Z'
                  }
                : { outcome: FiscalContingencyReportOutcome.UNAVAILABLE as const }
            )
        }
      : {})
  }
  return Object.assign(base, { sent })
}

const sale = (n: number, tags: string[] = ['a']): ConformanceStep => ({
  kind: 'sale',
  id: `S${n}`,
  tags,
  input: input(n)
})
const options = (p: FiscalDocumentProvider, over: Record<string, unknown> = {}) => ({
  provider: p,
  issuer: ISSUER,
  credentials: {},
  batch: 'b1',
  dryRun: false,
  ...over
})

describe('the conformance run', () => {
  it('sends the documents of a plan through the port and counts what the provider accepted, by type, with the variety of the plan', async () => {
    const p = provider()
    const report = await runConformance([sale(1, ['x', 'y']), sale(2, ['x'])], options(p))
    expect(p.sent).toEqual(['doc-1', 'doc-2'])
    expect(report.mode).toBe('live')
    expect(report.documents['T1']).toMatchObject({ planned: 2, built: 2, accepted: 2, rejected: 0 })
    expect(report.tags).toEqual({
      x: { planned: 2, succeeded: 2 },
      y: { planned: 1, succeeded: 1 }
    })
    expect(conformanceGaps(report, { documents: { T1: 2 }, voids: 0, contingencies: 0 }).ok).toBe(
      true
    )
    expect(conformanceGaps(report, { documents: { T1: 3 }, voids: 1, contingencies: 1 })).toEqual({
      ok: false,
      missing: { T1: 1, voids: 1, contingencies: 1 }
    })
  })

  it('in a dry run builds everything and sends nothing', async () => {
    const p = provider()
    const report = await runConformance([sale(1)], options(p, { dryRun: true }))
    expect(p.sent).toEqual([])
    expect(report.mode).toBe('dry_run')
    expect(report.steps[0]).toMatchObject({ outcome: ConformanceOutcome.DRY_RUN_BUILT })
    expect(report.documents['T1']).toMatchObject({ built: 1, accepted: 0 })
  })

  it('counts a refusal by the authority, a refusal before sending and a silence apart, with their codes', async () => {
    const unavailable: SubmitResult = { outcome: FiscalSubmitOutcome.UNAVAILABLE }
    const answers: SubmitResult[] = [
      { outcome: FiscalSubmitOutcome.REJECTED, reason: '020' },
      { outcome: FiscalSubmitOutcome.REJECTED, reason: 'credentials_incomplete', neverSent: true },
      unavailable
    ]
    let at = 0
    const p = provider({ submit: () => answers[at++] ?? unavailable })
    const report = await runConformance([sale(1), sale(2), sale(3)], options(p))
    expect(report.documents['T1']).toMatchObject({
      rejected: 1,
      notSent: 1,
      unavailable: 1,
      accepted: 0
    })
    expect(report.codes).toEqual({ '020': 1, credentials_incomplete: 1, no_answer: 1 })
  })

  it('keeps no free text of a provider or an authority: only what has the shape of a code', async () => {
    const p = provider({
      submit: () => ({
        outcome: FiscalSubmitOutcome.REJECTED,
        reason: 'El receptor Ana Pérez con NIT 0614-010101-101-1 es inválido'
      })
    })
    const report = await runConformance([sale(1)], options(p))
    expect(report.codes).toEqual({ unreadable: 1 })
    expect(JSON.stringify(report)).not.toContain('Ana')
    expect(safeCode('020')).toBe('020')
    expect(safeCode('a b')).toBe('unreadable')
    expect(safeCode(undefined)).toBe('unreadable')
  })

  it('keeps the name of an error a provider throws, never its message (it may carry the data of a document)', async () => {
    const boom = new TypeError('the tax number 0614-010101-101-1 is wrong')
    const p = provider({ buildThrows: () => boom })
    const report = await runConformance([sale(1)], options(p))
    expect(report.steps[0]).toMatchObject({ outcome: ConformanceOutcome.BUILD_FAILED })
    // A build that refuses with a code (the message is the code) keeps it; one with free text keeps the name
    expect(report.steps[0]?.code).toBe('error:TypeError')
    const coded = provider({ buildThrows: () => new Error('tax_outside_tolerance') })
    const again = await runConformance([sale(1)], options(coded))
    expect(again.steps[0]?.code).toBe('tax_outside_tolerance')
  })

  it('makes a credit note of the document the provider accepted, and skips it when there is none', async () => {
    const p = provider()
    const note: ConformanceStep = {
      kind: 'credit_note',
      id: 'N1',
      tags: ['n'],
      parent: 'S1',
      input: input(9, { kind: FiscalDocumentKind.CREDIT_NOTE })
    }
    const ok = await runConformance([sale(1), note], options(p))
    expect(ok.steps.map(step => step.outcome)).toEqual([
      ConformanceOutcome.ACCEPTED,
      ConformanceOutcome.ACCEPTED
    ])
    const orphan = await runConformance([note], options(provider()))
    expect(orphan.steps[0]).toMatchObject({
      outcome: ConformanceOutcome.SKIPPED,
      code: 'parent_missing'
    })
    // A parent the authority refused is no parent
    const refused = provider({
      submit: () => ({ outcome: FiscalSubmitOutcome.REJECTED, reason: '020' })
    })
    const none = await runConformance([sale(1), note], options(refused))
    expect(none.steps[1]).toMatchObject({ outcome: ConformanceOutcome.SKIPPED })
  })

  it('invalidates an accepted document and counts it, and says when the provider refused', async () => {
    const step = (target: string): ConformanceStep => ({
      kind: 'void',
      id: 'V1',
      tags: ['v'],
      target,
      reason: 'motivo',
      details: {},
      replacement: null
    })
    const done = await runConformance([sale(1), step('S1')], options(provider()))
    expect(done.voids).toEqual({ planned: 1, done: 1, refused: 0 })
    const refused = await runConformance(
      [sale(1), step('S1')],
      options(provider({ voidAnswer: { voided: false, reason: '053' } }))
    )
    expect(refused.voids).toEqual({ planned: 1, done: 0, refused: 1 })
    expect(refused.codes).toEqual({ '053': 1 })
    // Nothing to invalidate
    const missing = await runConformance([step('S9')], options(provider()))
    expect(missing.steps[0]).toMatchObject({ code: 'target_missing' })
  })

  it('skips the contingencies of a provider that has no contingency mode, and runs them for one that has', async () => {
    const steps: ConformanceStep[] = [
      { kind: 'deferred_sale', id: 'D1', tags: ['d'], input: input(1) },
      {
        kind: 'contingency',
        id: 'C1',
        tags: ['c'],
        documents: ['D1'],
        event: {
          eventId: 'e1',
          reason: '1',
          motive: null,
          startedAt: '2026-11-17T08:00:00.000Z',
          endedAt: '2026-11-17T09:00:00.000Z',
          responsible: null
        }
      }
    ]
    const none = await runConformance(steps, options(provider()))
    expect(none.steps.map(step => step.code)).toEqual([
      'no_contingency_mode',
      'no_contingency_mode'
    ])
    expect(none.contingencies).toMatchObject({ planned: 1, reported: 0 })

    const p = provider({ contingency: true })
    const done = await runConformance(steps, options(p))
    // The document is kept first and sent only after the event was taken
    expect(done.steps.map(step => step.outcome)).toEqual([
      ConformanceOutcome.DEFERRED,
      ConformanceOutcome.REPORTED,
      ConformanceOutcome.ACCEPTED
    ])
    expect(p.sent).toEqual(['doc-1'])
    expect(done.contingencies).toEqual({
      planned: 1,
      reported: 1,
      refused: 0,
      deferred: 1,
      deferredAccepted: 1
    })

    // An event that is not taken sends no document
    const down = provider({ contingency: true, report: FiscalContingencyReportOutcome.UNAVAILABLE })
    const stuck = await runConformance(steps, options(down))
    expect(down.sent).toEqual([])
    expect(stuck.contingencies).toMatchObject({ reported: 0, refused: 1, deferredAccepted: 0 })
  })
})

describe('what must never be in the report', () => {
  it('fails the run if a secret is anywhere in it, and says nothing of which', async () => {
    // A provider whose own id of the document type is the secret: the one thing a report repeats
    const p = provider({ documentType: 'ISSUER-SECRET-1234' })
    await expect(
      runConformance([sale(1)], options(p, { secrets: ['ISSUER-SECRET-1234'] }))
    ).rejects.toBeInstanceOf(ConformanceLeakError)
    await expect(
      runConformance([sale(1)], options(p, { secrets: ['ISSUER-SECRET-1234'] }))
    ).rejects.toThrow(/must stay secret/)
    await expect(
      runConformance([sale(1)], options(p, { secrets: ['ISSUER-SECRET-1234'] }))
    ).rejects.not.toThrow(/ISSUER-SECRET/)
  })

  it('does not look for short values, which any number would contain', () => {
    expect(() => assertNoSecrets({ n: '1234567' }, ['12', '', 'ab'])).not.toThrow()
    expect(() => assertNoSecrets({ n: '1234567' }, ['1234'])).toThrow(ConformanceLeakError)
  })

  it('carries no document, no number and no signed text: ids of the plan, kinds, outcomes and codes', async () => {
    const report = await runConformance([sale(1)], options(provider()))
    expect(Object.keys(report).sort()).toEqual([
      'batch',
      'codes',
      'contingencies',
      'documents',
      'mode',
      'steps',
      'tags',
      'unbuilt',
      'voids'
    ])
    expect(Object.keys(report.steps[0] ?? {}).sort()).toEqual([
      'code',
      'documentType',
      'id',
      'kind',
      'outcome'
    ])
    expect(JSON.stringify(report)).not.toContain('EXT-')
  })
})
