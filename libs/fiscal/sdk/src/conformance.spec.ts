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
  submitThrows?: (id: string) => boolean
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
      if (script.submitThrows?.(String(built.payload['id'])) === true) {
        return Promise.reject(new TypeError('boom with a secret 1234567'))
      }
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

const sale = (n: number, tags: string[] = ['a'], bucket: string | null = 'B'): ConformanceStep => ({
  kind: 'sale',
  id: `S${n}`,
  tags,
  bucket,
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
    expect(conformanceGaps(report, { buckets: { B: 2 }, voids: 0, contingencies: 0 }).ok).toBe(true)
    expect(conformanceGaps(report, { buckets: { B: 3 }, voids: 1, contingencies: 1 })).toEqual({
      ok: false,
      missing: { B: 1, voids: 1, contingencies: 1 }
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
      bucket: null,
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

describe('a document of a lot that breaks', () => {
  it('is a failure of its own and does not leave the rest of the lot unsent, nor count the event twice', async () => {
    const p = provider({ contingency: true, submitThrows: id => id === 'doc-2' })
    const event = {
      eventId: 'e1',
      reason: '1',
      motive: null,
      startedAt: '2026-11-17T08:00:00.000Z',
      endedAt: '2026-11-17T09:00:00.000Z',
      responsible: null
    }
    const steps: ConformanceStep[] = [
      { kind: 'deferred_sale', id: 'D1', tags: ['d'], input: input(1) },
      { kind: 'deferred_sale', id: 'D2', tags: ['d'], input: input(2) },
      { kind: 'deferred_sale', id: 'D3', tags: ['d'], input: input(3) },
      { kind: 'contingency', id: 'C1', tags: ['c'], documents: ['D1', 'D2', 'D3'], event }
    ]
    const report = await runConformance(steps, options(p))
    expect(p.sent).toEqual(['doc-1', 'doc-3'])
    expect(report.contingencies).toMatchObject({ reported: 1, deferred: 3, deferredAccepted: 2 })
    expect(report.steps.filter(step => step.id === 'C1')).toHaveLength(1)
    expect(
      report.steps.find(step => step.id === 'D2' && step.outcome === ConformanceOutcome.ERROR)?.code
    ).toBe('error:TypeError')
    // The message of the error, which carried a value, is nowhere
    expect(JSON.stringify(report)).not.toContain('1234567')
  })
})

describe('a step whose provider call throws', () => {
  const event = {
    eventId: 'e1',
    reason: '1',
    motive: null,
    startedAt: '2026-11-17T08:00:00.000Z',
    endedAt: '2026-11-17T09:00:00.000Z',
    responsible: null
  }

  it('counts an invalidation that broke as refused, and a contingency that broke as refused', async () => {
    const p = provider({ contingency: true })
    const broken: FiscalDocumentProvider = {
      ...p,
      void: () => Promise.reject(new TypeError('boom')),
      reportContingency: () => Promise.reject(new TypeError('boom'))
    }
    const steps: ConformanceStep[] = [
      sale(1),
      {
        kind: 'void',
        id: 'V1',
        tags: ['v'],
        target: 'S1',
        reason: 'r',
        details: {},
        replacement: null
      },
      { kind: 'deferred_sale', id: 'D1', tags: ['d'], input: input(2) },
      { kind: 'contingency', id: 'C1', tags: ['c'], documents: ['D1'], event }
    ]
    const report = await runConformance(steps, options(broken))
    expect(report.voids).toEqual({ planned: 1, done: 0, refused: 1 })
    expect(report.contingencies).toMatchObject({ planned: 1, reported: 0, refused: 1 })
  })

  it('takes back the success of a deferred document the authority refuses after its event', async () => {
    const p = provider({
      contingency: true,
      submit: () => ({ outcome: FiscalSubmitOutcome.REJECTED, reason: '020' })
    })
    const steps: ConformanceStep[] = [
      { kind: 'deferred_sale', id: 'D1', tags: ['deferred'], input: input(1) },
      { kind: 'contingency', id: 'C1', tags: ['c'], documents: ['D1'], event }
    ]
    const report = await runConformance(steps, options(p))
    expect(report.tags['deferred']).toEqual({ planned: 1, succeeded: 0 })
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
      'minimum',
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

  it('searches the secret as JSON writes it too: a quote or a backslash in a password is escaped in the text of the report', () => {
    expect(() => assertNoSecrets({ code: 'pa"ss\\word' }, ['pa"ss\\word'])).toThrow(
      ConformanceLeakError
    )
  })

  it('says, when it finds a secret, only numbers of what was done, so that it is not sent again', async () => {
    const p = provider({ documentType: 'ISSUER-SECRET-1234' })
    try {
      await runConformance([sale(1), sale(2)], options(p, { secrets: ['ISSUER-SECRET-1234'] }))
      throw new Error('it should have failed')
    } catch (error) {
      expect(error).toBeInstanceOf(ConformanceLeakError)
      expect((error as ConformanceLeakError).counts).toEqual({
        steps: 2,
        accepted: 2,
        refused: 0,
        unavailable: 0,
        voided: 0,
        contingenciesReported: 0
      })
      expect(JSON.stringify((error as ConformanceLeakError).counts)).not.toContain('SECRET')
    }
  })
})

describe('what counts toward the minimum', () => {
  it('counts only the documents made for it, so extra documents that are accepted never fill a gap left by one that is not', async () => {
    // Two of three documents of the bucket are refused; two extra documents (no bucket) are accepted
    const answers: SubmitResult[] = [
      { outcome: FiscalSubmitOutcome.ACCEPTED, externalNumber: 'E1' },
      { outcome: FiscalSubmitOutcome.REJECTED, reason: '020' },
      { outcome: FiscalSubmitOutcome.REJECTED, reason: '020' }
    ]
    let at = 0
    const p = provider({
      submit: () => answers[at++] ?? { outcome: FiscalSubmitOutcome.ACCEPTED, externalNumber: 'E' }
    })
    const report = await runConformance(
      [sale(1), sale(2), sale(3), sale(4, ['extra'], null), sale(5, ['extra'], null)],
      options(p)
    )
    expect(report.documents['T1']?.accepted).toBe(3)
    expect(report.minimum).toEqual({ B: { planned: 3, accepted: 1 } })
    expect(conformanceGaps(report, { buckets: { B: 3 }, voids: 0, contingencies: 0 })).toEqual({
      ok: false,
      missing: { B: 2 }
    })
  })
})
