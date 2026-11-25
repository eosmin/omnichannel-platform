import { FiscalDocumentKind, FiscalVoidKind } from '@platform/core/domain'
import {
  conformanceGaps,
  ConformanceOutcome,
  runConformance,
  type ConformanceStep
} from '@platform/fiscal/sdk'

import { buildDocument } from '../sv-build'
import { SvContingency, SvCredentialKeys, SvDocumentTypes } from '../sv-constants'
import { svProvider } from '../sv-provider'
import { officialSigner } from '../sv-signer'
import { isValidSvNationalId } from '../sv-tax-id'
import { FAKE, startFakeAuthority, type FakeAuthority } from '../testing/fake-authority'
import { schemaErrors } from '../testing/sv-fixtures'

import {
  planSvConformance,
  SvConformanceBuckets,
  SvConformanceDefaults,
  SvConformanceLimits,
  SvConformanceDemoIssuer,
  svConformanceTargets,
  svDryRunCredited,
  svMonthJustStarted,
  svNextOffset
} from './sv-conformance-plan'
import { readSvSandboxEnv, SvSandboxConfirmation, SvSandboxEnvNames } from './sv-sandbox-env'

// The minimum tests of the sandbox, against the rules of the provider and against the server of our own that plays the authority. Nothing
// here reaches the real authority and nothing is a real number or a real person.

const NOW = new Date('2026-11-17T15:00:00.000Z')
const ISSUER = { ...SvConformanceDemoIssuer, taxId: '0614-010101-101-1' }
const CREDENTIALS = {
  [SvCredentialKeys.API_PASSWORD]: FAKE.API_PASSWORD,
  [SvCredentialKeys.CERTIFICATE_PASSWORD]: FAKE.KEY_PASSWORD
}
const plan = (over: Partial<Parameters<typeof planSvConformance>[0]> = {}): ConformanceStep[] =>
  planSvConformance({ issuer: ISSUER, batch: 'spec', seed: 11, now: NOW, ...over })

describe('the plan of the minimum tests', () => {
  const steps = plan()
  const kinds = (kind: ConformanceStep['kind']): ConformanceStep[] =>
    steps.filter(step => step.kind === kind)

  it('has what the authority asks: 90 invoices, 75 tax credit documents, 50 credit notes, 25 debit notes, 50 remission notes, 25 invoices of an excluded subject, 5 invalidations and 5 contingencies', () => {
    const sales = kinds('sale')
    // The minimum, and the documents made for the invalidations (the ones of the minimum are never touched)
    expect(sales.filter(step => step.id.startsWith('INV-'))).toHaveLength(90)
    expect(sales.filter(step => step.id.startsWith('CCF-'))).toHaveLength(75)
    expect(kinds('credit_note')).toHaveLength(50)
    expect(kinds('debit_note')).toHaveLength(25)
    expect(sales.filter(step => step.id.startsWith('NR-'))).toHaveLength(50)
    expect(sales.filter(step => step.id.startsWith('FSE-'))).toHaveLength(25)
    expect(kinds('void')).toHaveLength(5)
    expect(kinds('contingency')).toHaveLength(5)
    expect(kinds('deferred_sale')).toHaveLength(5 * SvConformanceDefaults.deferredPerContingency)
    expect(svConformanceTargets()).toEqual({
      buckets: {
        [SvConformanceBuckets.INVOICE]: 90,
        [SvConformanceBuckets.TAX_CREDIT]: 75,
        [SvConformanceBuckets.CREDIT_NOTE]: 50,
        [SvConformanceBuckets.DEBIT_NOTE]: 25,
        [SvConformanceBuckets.REMISSION_NOTE]: 50,
        [SvConformanceBuckets.EXCLUDED_SUBJECT]: 25
      },
      voids: 5,
      contingencies: 5
    })
  })

  it('plans the remission notes after every other step, so the values of the earlier ones do not move', () => {
    const first = steps.findIndex(step => step.id.startsWith('NR-'))
    expect(first).toBeGreaterThan(0)
    expect(steps.slice(first, first + 50).every(step => step.id.startsWith('NR-'))).toBe(true)
    // Only the invoices of an excluded subject follow them, the last of all
    expect(steps.slice(first + 50).every(step => step.id.startsWith('FSE-'))).toBe(true)
    expect(steps.slice(first + 50)).toHaveLength(25)
  })

  it('makes 25 purchases from sellers who are no taxpayers, in many shapes, each stating its withholding and with no tax', () => {
    const purchases = steps.filter(
      (step): step is Extract<ConformanceStep, { kind: 'sale' }> =>
        step.kind === 'sale' && step.id.startsWith('FSE-')
    )
    expect(purchases).toHaveLength(25)
    for (const step of purchases) {
      expect(step.bucket).toBe(SvConformanceBuckets.EXCLUDED_SUBJECT)
      expect(step.input.kind).toBe(FiscalDocumentKind.PURCHASE)
      // Stated, never assumed: the goods of the plan are bought with no withholding
      expect(step.input.withheldIncomeTaxCents).toBe(0)
      expect(step.input.taxCents).toBe(0)
      expect(step.input.receiver.registrationId).toBeNull()
      expect(step.input.receiver.address).not.toBeNull()
      const built = buildDocument(step.input)
      expect(built.documentType).toBe(SvDocumentTypes.EXCLUDED_SUBJECT)
      expect(built.missingReceiverFields).toEqual([])
    }
    const tags = new Set(purchases.flatMap(step => step.tags))
    for (const wanted of [
      'seller_national_id',
      'seller_tax_number',
      'seller_other_document',
      'discount'
    ]) {
      expect(tags).toContain(wanted)
    }
  })

  it('gives every recipient of a remission note an identity document the entry of a person would accept, whatever its tag', () => {
    for (const step of steps.filter(candidate => candidate.id.startsWith('NR-'))) {
      if (!('input' in step)) continue
      const { receiver } = step.input
      if (step.tags.includes('recipient_national_id')) {
        expect(receiver.documentType).toBe('13')
        expect(isValidSvNationalId(receiver.taxId ?? '')).toBe(true)
      } else if (step.tags.includes('recipient_tax_number')) {
        expect(receiver.documentType).toBe('36')
      } else {
        expect(step.tags).toContain('recipient_company')
        expect(receiver.registrationId).not.toBeNull()
      }
    }
  })

  it('is the same for the same options and different for another seed, and never repeats a generation code or a number of a series', () => {
    expect(JSON.stringify(plan())).toBe(JSON.stringify(plan()))
    expect(JSON.stringify(plan({ seed: 12 }))).not.toBe(JSON.stringify(plan()))
    const codes = steps.flatMap(step => ('input' in step ? [step.input.documentUuid] : []))
    expect(new Set(codes).size).toBe(codes.length)
    // Another batch is another set of documents for the authority
    const other = plan({ batch: 'another' }).flatMap(step =>
      'input' in step ? [step.input.documentUuid] : []
    )
    expect(other.filter(code => codes.includes(code))).toEqual([])
    // The series start after the offset
    const shifted = plan({ correlativeOffset: 1000 }).find(step => step.id === 'INV-001')
    expect(shifted !== undefined && 'input' in shifted ? shifted.input.correlative : 0).toBe(1001)
  })

  it('is varied: receivers, tax treatments, discounts, shipping, roundings, prices with and without tax, credit terms and returns', () => {
    const tags = new Set(steps.flatMap(step => step.tags))
    for (const wanted of [
      'consumer_anonymous',
      'consumer_national_id',
      'consumer_tax_number',
      'mixed',
      'rounding',
      'many',
      'discount',
      'shipping_taxed',
      'shipping_exempt',
      'prices_net',
      'prices_with_tax',
      'recipient_company',
      'recipient_national_id',
      'recipient_tax_number',
      'credit_term',
      'whole_return',
      'partial_return',
      `void_${FiscalVoidKind.RESCISSION}`,
      `void_${FiscalVoidKind.CORRECTION}`,
      `void_${FiscalVoidKind.OTHER}`
    ]) {
      expect(tags).toContain(wanted)
    }
    // Every reason of the catalog in turn, the one that is "other" with words
    for (const reason of Object.values(SvContingency.REASONS)) {
      expect(tags).toContain(`contingency_reason_${reason}`)
    }
  })

  it('makes every document with the rules of the provider and the schema of the authority', () => {
    const parents = new Map<string, ReturnType<typeof buildDocument>>()
    for (const step of steps) {
      if (step.kind === 'sale' || step.kind === 'deferred_sale') {
        const built = buildDocument(step.input)
        parents.set(step.id, built)
        expect(schemaErrors(built.documentType, built.payload)).toEqual([])
        // A remission note of the plan is built as such, with no receiver field left to complete
        if (step.id.startsWith('NR-')) {
          expect(built.documentType).toBe(SvDocumentTypes.REMISSION_NOTE)
          expect(built.missingReceiverFields).toEqual([])
        }
      }
      if (step.kind === 'credit_note' || step.kind === 'debit_note') {
        const parent = parents.get(step.parent)
        const parentStep = steps.find(candidate => candidate.id === step.parent)
        expect(parent).toBeDefined()
        if (parent === undefined || parentStep === undefined || !('input' in parentStep)) continue
        const credited = svDryRunCredited(parent, parentStep.input)
        expect(credited).not.toBeNull()
        const built = buildDocument({ ...step.input, credited })
        expect(built.documentType).toBe(
          step.kind === 'credit_note' ? SvDocumentTypes.CREDIT_NOTE : SvDocumentTypes.DEBIT_NOTE
        )
        expect(schemaErrors(built.documentType, built.payload)).toEqual([])
      }
    }
  })

  it('dates every document before the moment it is sent and in the month of the run, and invents every number', () => {
    const month = NOW.getUTCMonth()
    for (const step of steps) {
      if (!('input' in step) || step.kind === 'deferred_sale') continue
      const issued = new Date(step.input.issuedAt)
      expect(issued.getTime()).toBeLessThan(NOW.getTime())
      expect(issued.getUTCMonth()).toBe(month)
    }
    // Invented tax numbers begin with four zeros, which no taxpayer has
    for (const step of steps) {
      if (!('input' in step)) continue
      const taxId = step.input.receiver.taxId
      if (taxId !== null && taxId.length === 14) expect(taxId.startsWith('0000')).toBe(true)
    }
  })

  it('never makes a credit note for more than the document it credits, nor an anonymous invoice over the threshold, nor overlapping contingency windows', () => {
    const inputs = new Map(
      steps.flatMap(step => ('input' in step ? [[step.id, step.input] as const] : []))
    )
    for (const step of steps) {
      if (step.kind === 'debit_note') {
        // A debit note is never dated before the document it adds to, and charges something
        const parent = inputs.get(step.parent)
        expect(parent).toBeDefined()
        expect(step.input.totalCents).toBeGreaterThan(0)
        expect(Date.parse(step.input.issuedAt)).toBeGreaterThanOrEqual(
          Date.parse(parent?.issuedAt ?? '')
        )
      }
      if (step.kind === 'credit_note') {
        const parent = inputs.get(step.parent)
        expect(parent).toBeDefined()
        expect(step.input.totalCents).toBeLessThanOrEqual(parent?.totalCents ?? 0)
        // And never dated before the document it credits
        expect(Date.parse(step.input.issuedAt)).toBeGreaterThanOrEqual(
          Date.parse(parent?.issuedAt ?? '')
        )
      }
      if (step.kind === 'sale' && step.input.receiver.taxId === null) {
        expect(step.input.totalCents).toBeLessThan(SvConformanceLimits.ANONYMOUS_INVOICE_CENTS)
      }
    }
    const windows = kinds('contingency')
      .map(step => (step.kind === 'contingency' ? step.event : null))
      .filter(event => event !== null)
      .map(event => [Date.parse(event.startedAt), Date.parse(event.endedAt)] as const)
      .sort((a, b) => a[0] - b[0])
    for (let at = 1; at < windows.length; at += 1) {
      expect(windows[at]?.[0] ?? 0).toBeGreaterThanOrEqual(
        windows[at - 1]?.[1] ?? Number.MAX_SAFE_INTEGER
      )
    }
    // And dated within two days before the moment of the run
    for (const step of steps) {
      if (!('input' in step) || step.kind === 'deferred_sale') continue
      expect(NOW.getTime() - Date.parse(step.input.issuedAt)).toBeLessThanOrEqual(
        SvConformanceLimits.MAX_BACK_MINUTES * 60_000
      )
    }
  })

  it('says the number the next run starts from, and knows the first minutes of a month of El Salvador', () => {
    // The series of the invoices holds the minimum and the documents made for the invalidations and the contingencies
    expect(svNextOffset(steps)).toBe(90 + 5 + 3 + 10)
    // 2026-12-01 00:10 in El Salvador is 06:10 UTC; an hour later is not "just started"
    expect(svMonthJustStarted(new Date('2026-12-01T06:10:00.000Z'))).toBe(true)
    expect(svMonthJustStarted(new Date('2026-12-01T07:30:00.000Z'))).toBe(false)
    // 2026-12-01 03:00 UTC is still the 30th of November there
    expect(svMonthJustStarted(new Date('2026-12-01T03:00:00.000Z'))).toBe(false)
  })

  it('takes smaller counts when they are asked for', () => {
    const small = plan({
      counts: {
        invoices: 3,
        taxCredits: 2,
        creditNotes: 9,
        debitNotes: 30,
        remissionNotes: 4,
        excludedSubjects: 3,
        voids: 1,
        contingencies: 1
      }
    })
    expect(small.filter(step => step.kind === 'credit_note')).toHaveLength(2)
    expect(small.filter(step => step.kind === 'debit_note')).toHaveLength(2)
    expect(small.filter(step => step.id.startsWith('NR-'))).toHaveLength(4)
    expect(small.filter(step => step.id.startsWith('FSE-'))).toHaveLength(3)
    expect(small.filter(step => step.kind === 'void')).toHaveLength(1)
    expect(
      svConformanceTargets({ taxCredits: 2, creditNotes: 9 }).buckets[
        SvConformanceBuckets.CREDIT_NOTE
      ]
    ).toBe(2)
    expect(
      svConformanceTargets({ taxCredits: 2, debitNotes: 30 }).buckets[
        SvConformanceBuckets.DEBIT_NOTE
      ]
    ).toBe(2)
    // A remission note names no document, so its count is not bounded by the tax credit documents
    expect(
      svConformanceTargets({ taxCredits: 2, remissionNotes: 7 }).buckets[
        SvConformanceBuckets.REMISSION_NOTE
      ]
    ).toBe(7)
  })
})

describe('the plan against the server that plays the authority', () => {
  let authority: FakeAuthority
  beforeAll(async () => {
    authority = await startFakeAuthority()
  })
  afterAll(async () => {
    await authority.close()
  })

  const provider = () =>
    svProvider({
      signer: officialSigner({
        baseUrl: authority.baseUrl,
        fetch: (url, init) => fetch(url, init),
        timeoutMs: 5000
      }),
      endpoints: authority.endpoints
    })
  const run = (over: Record<string, unknown> = {}) =>
    runConformance(plan(), {
      provider: provider(),
      issuer: ISSUER,
      credentials: CREDENTIALS,
      batch: 'spec',
      dryRun: false,
      secrets: [FAKE.API_PASSWORD, FAKE.KEY_PASSWORD, FAKE.NIT],
      dryRunCredited: svDryRunCredited,
      ...over
    })

  it('reaches the minimum: 90, 75 and 50 with seal, 5 invalidations and 5 contingencies reported', async () => {
    authority.forgetDocuments()
    const report = await run()
    expect(conformanceGaps(report, svConformanceTargets())).toEqual({ ok: true, missing: {} })
    expect(report.voids).toEqual({ planned: 5, done: 5, refused: 0 })
    expect(report.contingencies).toMatchObject({ planned: 5, reported: 5, refused: 0 })
    expect(report.contingencies.deferredAccepted).toBe(report.contingencies.deferred)
    expect(report.steps.filter(step => step.outcome === ConformanceOutcome.ERROR)).toEqual([])
    expect(report.codes).toEqual({})
  }, 120_000)

  it('is not a duplicate of an earlier run when it has another batch and its series start after the offset', async () => {
    authority.forgetDocuments()
    const small = {
      counts: { invoices: 3, taxCredits: 2, creditNotes: 1, voids: 1, contingencies: 1 }
    }
    const runOf = (batch: string, correlativeOffset: number) =>
      runConformance(plan({ ...small, batch, correlativeOffset }), {
        provider: provider(),
        issuer: ISSUER,
        credentials: CREDENTIALS,
        batch,
        dryRun: false,
        dryRunCredited: svDryRunCredited
      })
    expect((await runOf('first', 0)).codes).toEqual({})
    expect((await runOf('second', 500)).codes).toEqual({})
  }, 60_000)

  it('in a dry run builds the five kinds of document and sends nothing', async () => {
    const before = authority.stats.receptions
    const report = await run({ dryRun: true })
    expect(authority.stats.receptions).toBe(before)
    expect(report.documents[SvDocumentTypes.CREDIT_NOTE]).toMatchObject({
      planned: 50,
      built: 50,
      accepted: 0
    })
    expect(report.documents[SvDocumentTypes.DEBIT_NOTE]).toMatchObject({
      planned: 25,
      built: 25,
      accepted: 0
    })
    expect(report.documents[SvDocumentTypes.REMISSION_NOTE]).toMatchObject({
      planned: 50,
      built: 50,
      accepted: 0
    })
    expect(report.steps.filter(step => step.outcome === ConformanceOutcome.BUILD_FAILED)).toEqual(
      []
    )
  })

  it('leaks nothing: no password, no token, no tax number, no signed text and no generation code is in what it says', async () => {
    authority.forgetDocuments()
    const report = await run()
    const text = JSON.stringify(report)
    for (const secret of [
      FAKE.API_PASSWORD,
      FAKE.KEY_PASSWORD,
      FAKE.NIT,
      ISSUER.taxId,
      'Bearer',
      'eyJ',
      authority.baseUrl
    ]) {
      expect(text).not.toContain(secret)
    }
    // Nor a generation code, a control number or a seal of the documents it made
    expect(text).not.toMatch(/[A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12}/)
    expect(text).not.toMatch(/DTE-\d{2}-/)
  }, 120_000)
})

describe('what is read of the environment of the owner', () => {
  const FULL: Record<string, string> = {
    [SvSandboxEnvNames.CONFIRM]: SvSandboxConfirmation,
    [SvSandboxEnvNames.SIGNER_URL]: 'http://signer.internal:8113',
    [SvSandboxEnvNames.TAX_ID]: '0614-010101-101-1',
    [SvSandboxEnvNames.API_PASSWORD]: 'api-password-secret',
    [SvSandboxEnvNames.KEY_PASSWORD]: 'key-password-secret',
    [SvSandboxEnvNames.LEGAL_NAME]: 'Mi Empresa S.A.',
    [SvSandboxEnvNames.REGISTRATION]: '123456-7',
    [SvSandboxEnvNames.ACTIVITY]: '47119',
    [SvSandboxEnvNames.ESTABLISHMENT_CODE]: 'M001',
    [SvSandboxEnvNames.ESTABLISHMENT_TYPE]: '02',
    [SvSandboxEnvNames.POINT_OF_SALE_CODE]: 'P001',
    [SvSandboxEnvNames.DEPARTMENT]: '06',
    [SvSandboxEnvNames.MUNICIPALITY]: '23',
    [SvSandboxEnvNames.DISTRICT]: '01',
    [SvSandboxEnvNames.COMPLEMENT]: 'Calle 1',
    [SvSandboxEnvNames.PHONE]: '22220000',
    [SvSandboxEnvNames.EMAIL]: 'yo@example.test',
    [SvSandboxEnvNames.RESPONSIBLE_NAME]: 'Ana Pérez',
    [SvSandboxEnvNames.RESPONSIBLE_ID_TYPE]: '13',
    [SvSandboxEnvNames.RESPONSIBLE_ID_NUMBER]: '012345678'
  }

  it('is not ready with nothing set, and lists the names and never a value', () => {
    const reading = readSvSandboxEnv({})
    expect(reading.ready).toBe(false)
    if (reading.ready) return
    expect(reading.missing).toContain(SvSandboxEnvNames.API_PASSWORD)
    expect(reading.confirmed).toBe(false)
  })

  it('is not ready without the confirmation of the owner, whatever else is set, and says no value even then', () => {
    const withoutIt = Object.fromEntries(
      Object.entries(FULL).filter(([name]) => name !== SvSandboxEnvNames.CONFIRM)
    )
    const reading = readSvSandboxEnv(withoutIt)
    expect(reading.ready).toBe(false)
    const wrong = readSvSandboxEnv({ ...FULL, [SvSandboxEnvNames.CONFIRM]: 'yes' })
    expect(wrong.ready).toBe(false)
    for (const attempt of [reading, wrong]) {
      const text = JSON.stringify(attempt)
      for (const value of Object.values(FULL)) {
        if (value.length >= 4) expect(text).not.toContain(value)
      }
    }
  })

  it('refuses a password too short to be searched for in a report, as if it were missing, and keeps names and contact out of the secrets', () => {
    const short = readSvSandboxEnv({ ...FULL, [SvSandboxEnvNames.KEY_PASSWORD]: 'abc' })
    expect(short.ready).toBe(false)
    if (short.ready) return
    expect(short.missing).toEqual([SvSandboxEnvNames.KEY_PASSWORD])
    const ready = readSvSandboxEnv(FULL)
    if (!ready.ready) throw new Error('it should be ready')
    expect(ready.setup.secrets).not.toContain('Mi Empresa S.A.')
    // The number of the responsible person as typed and as digits (the documents carry it without dashes)
    const dashed = readSvSandboxEnv({
      ...FULL,
      [SvSandboxEnvNames.RESPONSIBLE_ID_NUMBER]: '01234567-8'
    })
    if (!dashed.ready) throw new Error('it should be ready')
    expect(dashed.setup.secrets).toEqual(expect.arrayContaining(['01234567-8', '012345678']))
    expect(ready.setup.secrets).not.toContain('yo@example.test')
  })

  it('keeps a password as it was typed, with the space at its end', () => {
    const reading = readSvSandboxEnv({ ...FULL, [SvSandboxEnvNames.KEY_PASSWORD]: 'key-secret ' })
    if (!reading.ready) throw new Error('it should be ready')
    expect(reading.setup.credentials[SvCredentialKeys.CERTIFICATE_PASSWORD]).toBe('key-secret ')
  })

  it('is not ready with a name missing, and a blank value is a missing one', () => {
    const reading = readSvSandboxEnv({ ...FULL, [SvSandboxEnvNames.KEY_PASSWORD]: '   ' })
    expect(reading.ready).toBe(false)
    if (reading.ready) return
    expect(reading.missing).toEqual([SvSandboxEnvNames.KEY_PASSWORD])
  })

  it('is ready when all is set and confirmed: the sandbox is the only environment it can make, and the secrets are kept to be checked', () => {
    const reading = readSvSandboxEnv(FULL)
    expect(reading.ready).toBe(true)
    if (!reading.ready) return
    expect(reading.setup.issuer.environment).toBe('sandbox')
    expect(reading.setup.secrets).toEqual(
      expect.arrayContaining([
        'api-password-secret',
        'key-password-secret',
        '0614-010101-101-1',
        '06140101011011',
        '012345678'
      ])
    )
  })
})
