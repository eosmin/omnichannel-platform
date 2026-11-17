import {
  FiscalContingencyReportOutcome,
  FiscalDeferOutcome,
  FiscalSubmitOutcome
} from '@platform/core/domain'
import type {
  BuiltDocument,
  FiscalContingencyEvent,
  ProviderContext,
  StoredFiscalDocument
} from '@platform/fiscal/sdk'

import { buildDocument } from './sv-build'
import {
  SvBuildErrors,
  SvContingency,
  SvContingencyRefusals,
  SvCredentialKeys
} from './sv-constants'
import { buildContingencyEvent } from './sv-contingency'
import { svProvider, type SvProvider } from './sv-provider'
import { officialSigner } from './sv-signer'
import { FAKE, startFakeAuthority, verifyJws, type FakeAuthority } from './testing/fake-authority'
import { CONSUMER, ISSUER, sale, schemaErrors } from './testing/sv-fixtures'

const PERSON = { name: 'Ana Pérez', idType: '13', idNumber: '012345678' }
const NOW = '2026-11-18T15:00:00.000Z'
const ISSUER_OF_FAKE = { ...ISSUER, taxId: '0614-010101-101-1' }
const CREDENTIALS = {
  [SvCredentialKeys.API_PASSWORD]: FAKE.API_PASSWORD,
  [SvCredentialKeys.CERTIFICATE_PASSWORD]: FAKE.KEY_PASSWORD
}
const AUTHORITY_DOWN = { reason: String(SvContingency.REASONS.AUTHORITY_DOWN), motive: null }

const deferredSale = (n: number, over = {}) =>
  sale({
    correlative: n,
    documentUuid: `1b9d6bcd-bbfd-4b2d-9b5d-${String(n).padStart(12, '0')}`,
    contingency: AUTHORITY_DOWN,
    ...over
  })

const stored = (built: BuiltDocument): StoredFiscalDocument => ({
  documentType: built.documentType,
  externalNumber: null,
  providerData: null,
  payload: built.payload
})

const eventOf = (
  documents: StoredFiscalDocument[],
  over: Partial<FiscalContingencyEvent> = {}
): FiscalContingencyEvent => ({
  eventId: '3c9d6bcd-bbfd-4b2d-9b5d-00000000a001',
  reason: String(SvContingency.REASONS.AUTHORITY_DOWN),
  motive: null,
  startedAt: '2026-11-18T10:00:00.000Z',
  endedAt: '2026-11-18T14:30:00.000Z',
  documents,
  responsible: PERSON,
  ...over
})

describe('a document made in contingency', () => {
  it('is deferred: model 2, operation 2 and the reason of the catalog, and it still follows the schema of its type', () => {
    const built = buildDocument(deferredSale(1))
    expect(built.payload['identificacion']).toMatchObject({
      tipoModelo: 2,
      tipoOperacion: 2,
      tipoContingencia: 1,
      motivoContin: null
    })
    expect(schemaErrors(built.documentType, built.payload)).toEqual([])
  })

  it('a normal document stays in the previous model with no reason', () => {
    const built = buildDocument(sale())
    expect(built.payload['identificacion']).toMatchObject({
      tipoModelo: 1,
      tipoOperacion: 1,
      tipoContingencia: null,
      motivoContin: null
    })
  })

  it('carries the words of the person only for the reason "other", and then they are required', () => {
    const other = buildDocument(
      deferredSale(2, { contingency: { reason: '5', motive: '  Falla del enlace con el banco  ' } })
    )
    expect(other.payload['identificacion']).toMatchObject({
      tipoContingencia: 5,
      motivoContin: 'Falla del enlace con el banco'
    })
    expect(schemaErrors(other.documentType, other.payload)).toEqual([])
    const power = buildDocument(
      deferredSale(3, { contingency: { reason: '4', motive: 'lo que sea' } })
    )
    expect(power.payload['identificacion']).toMatchObject({
      tipoContingencia: 4,
      motivoContin: null
    })
    expect(() =>
      buildDocument(deferredSale(4, { contingency: { reason: '5', motive: '  ' } }))
    ).toThrow(SvBuildErrors.CONTINGENCY_MOTIVE_REQUIRED)
    expect(() =>
      buildDocument(deferredSale(5, { contingency: { reason: '9', motive: null } }))
    ).toThrow(SvBuildErrors.CONTINGENCY_REASON_UNKNOWN)
  })
})

describe('the event of a contingency', () => {
  const documents = [1, 2, 3].map(n => stored(buildDocument(deferredSale(n))))
  const [first] = documents
  if (first === undefined) throw new Error('no document')

  it('follows the official schema and lists the documents by their generation code, in order', () => {
    const built = buildContingencyEvent(eventOf(documents), ISSUER, NOW)
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(schemaErrors('contingency', built.event)).toEqual([])
    expect(built.event['detalleDTE']).toEqual([
      { noItem: 1, tipoDoc: '01', codigoGeneracion: '1B9D6BCD-BBFD-4B2D-9B5D-000000000001' },
      { noItem: 2, tipoDoc: '01', codigoGeneracion: '1B9D6BCD-BBFD-4B2D-9B5D-000000000002' },
      { noItem: 3, tipoDoc: '01', codigoGeneracion: '1B9D6BCD-BBFD-4B2D-9B5D-000000000003' }
    ])
    // In the time of El Salvador (UTC-6): the window and the moment of the event
    expect(built.event['motivo']).toEqual({
      fInicio: '2026-11-18',
      fFin: '2026-11-18',
      hInicio: '04:00:00',
      hFin: '08:30:00',
      tipoContingencia: 1,
      motivoContingencia: null
    })
    expect(built.event['identificacion']).toMatchObject({
      version: 4,
      codigoGeneracion: '3C9D6BCD-BBFD-4B2D-9B5D-00000000A001',
      fTransmision: '2026-11-18',
      hTransmision: '09:00:00'
    })
    expect(built.event['emisor']).toMatchObject({
      nombreResponsable: 'Ana Pérez',
      tipoDocResponsable: '13',
      numeroDocResponsable: '012345678'
    })
  })

  it('refuses, with a code and nothing sent, what the authority would not take', () => {
    const reason = (event: FiscalContingencyEvent, issuer = ISSUER) => {
      const built = buildContingencyEvent(event, issuer, NOW)
      return built.ok ? null : built.reason
    }
    expect(reason(eventOf(documents, { reason: '9' }))).toBe(SvContingencyRefusals.REASON_UNKNOWN)
    expect(reason(eventOf(documents, { reason: '5', motive: null }))).toBe(
      SvContingencyRefusals.MOTIVE_REQUIRED
    )
    expect(reason(eventOf(documents, { responsible: null }))).toBe(
      SvContingencyRefusals.RESPONSIBLE_REQUIRED
    )
    expect(reason(eventOf(documents, { responsible: { ...PERSON, idType: '99' } }))).toBe(
      SvContingencyRefusals.PARTY_INVALID
    )
    expect(reason(eventOf([]))).toBe(SvContingencyRefusals.DOCUMENTS_INVALID)
    expect(reason(eventOf([first, first]))).toBe(SvContingencyRefusals.DOCUMENTS_INVALID)
    // A document made the normal way is not part of a contingency
    expect(reason(eventOf([stored(buildDocument(sale()))]))).toBe(
      SvContingencyRefusals.DOCUMENTS_INVALID
    )
    expect(reason(eventOf(documents, { endedAt: '2026-11-18T09:00:00.000Z' }))).toBe(
      SvContingencyRefusals.WINDOW_INVALID
    )
    expect(reason(eventOf(documents), { ...ISSUER, phone: null })).toBe(
      SvContingencyRefusals.ISSUER_INCOMPLETE
    )
  })

  it('takes at most the documents of one event', () => {
    const many = Array.from({ length: SvContingency.MAX_DOCUMENTS + 1 }, (_, i) => ({
      ...first,
      payload: {
        ...first.payload,
        identificacion: {
          ...(first.payload['identificacion'] as object),
          codigoGeneracion: `1B9D6BCD-BBFD-4B2D-9B5D-${String(i).padStart(12, '0')}`
        }
      }
    }))
    const built = buildContingencyEvent(eventOf(many), ISSUER, NOW)
    expect(built.ok ? null : built.reason).toBe(SvContingencyRefusals.TOO_MANY_DOCUMENTS)
  })
})

describe('the provider against the authority while it is down', () => {
  let authority: FakeAuthority
  let provider: SvProvider
  const clock = Date.parse(NOW)

  const ctx = (over: Partial<ProviderContext> = {}): ProviderContext => ({
    issuer: ISSUER_OF_FAKE,
    credentials: CREDENTIALS,
    idempotencyKey: 'org:contingency:1',
    attempt: 1,
    ...over
  })

  beforeAll(async () => {
    authority = await startFakeAuthority()
    provider = svProvider({
      signer: officialSigner({
        baseUrl: authority.baseUrl,
        fetch: (url, init) => fetch(url, init),
        timeoutMs: 2000
      }),
      now: () => clock,
      endpoints: authority.endpoints
    })
  })
  afterAll(async () => {
    await authority.close()
  })
  beforeEach(() => {
    authority.forgetDocuments()
    authority.receptionDown = false
    authority.contingencyMode = 'normal'
    authority.signerDown = false
    authority.expireTokens()
  })

  const made = async (n: number): Promise<BuiltDocument> => {
    const built = await provider.build(deferredSale(n, { receiver: CONSUMER }))
    return built
  }

  it('declares the deferred model in its manifest', () => {
    expect(provider.manifest.contingencyMode).toEqual({
      reasons: ['1', '2', '3', '4', '5'],
      authorityDownReason: '1',
      transmitWithinHours: 72,
      maxDocumentsPerEvent: 1000,
      requiresResponsible: true
    })
  })

  it('signs a deferred document without the authority and keeps what is signed; it sends nothing', async () => {
    authority.receptionDown = true
    const built = await made(1)
    const result = await provider.deferDocument(built, ctx())
    expect(result.outcome).toBe(FiscalDeferOutcome.DEFERRED)
    if (result.outcome !== FiscalDeferOutcome.DEFERRED) return
    expect(authority.stats.receptions).toBe(0)
    expect(authority.stats.logins).toBe(0)
    const signed = verifyJws(String(result.providerData?.['signedDocument']))
    expect(signed).toEqual(JSON.parse(JSON.stringify(built.payload)))
  })

  it('does not keep a document that cannot be signed, nor one that was not built for the deferred model', async () => {
    authority.signerDown = true
    expect((await provider.deferDocument(await made(2), ctx())).outcome).toBe(
      FiscalDeferOutcome.UNAVAILABLE
    )
    authority.signerDown = false
    const normal = await provider.build(sale({ receiver: CONSUMER }))
    const refused = await provider.deferDocument(normal, ctx())
    expect(refused).toEqual({
      outcome: FiscalDeferOutcome.REJECTED,
      reason: SvContingencyRefusals.DOCUMENT_INCOMPLETE
    })
    const wrong = await provider.deferDocument(await made(3), ctx({ credentials: {} }))
    expect(wrong).toEqual({
      outcome: FiscalDeferOutcome.REJECTED,
      reason: SvContingencyRefusals.CREDENTIALS_INCOMPLETE
    })
  })

  it('the authority does not take a deferred document before an event listed it', async () => {
    const built = await made(4)
    const early = await provider.submit(built, ctx())
    expect(early.outcome).toBe(FiscalSubmitOutcome.REJECTED)
  })

  it('reports the event, gets the seal and the window starts when the authority took it; then the documents go', async () => {
    const documents = [await made(5), await made(6)]
    const reported = await provider.reportContingency(eventOf(documents.map(stored)), ctx())
    expect(reported.outcome).toBe(FiscalContingencyReportOutcome.ACCEPTED)
    if (reported.outcome !== FiscalContingencyReportOutcome.ACCEPTED) return
    expect(authority.stats.contingencies).toBe(1)
    expect(String(reported.providerData?.['receptionSeal'])).toHaveLength(40)
    // The authority said 09:00:00 of 17/11/2026 (UTC-6), which is earlier than our clock: the window counts from the earlier one
    expect(reported.receivedAt).toBe('2026-11-17T15:00:00.000Z')
    expect(schemaErrors('contingency', authority.stats.lastContingency)).toEqual([])
    for (const document of documents) {
      const result = await provider.submit(document, ctx())
      expect(result.outcome).toBe(FiscalSubmitOutcome.ACCEPTED)
    }
  })

  it('answers "unavailable" when the authority does not answer the event, and keeps the refusal code when it refuses', async () => {
    const documents = [stored(await made(7))]
    authority.contingencyMode = 'down'
    expect((await provider.reportContingency(eventOf(documents), ctx())).outcome).toBe(
      FiscalContingencyReportOutcome.UNAVAILABLE
    )
    authority.contingencyMode = 'refuse'
    const refused = await provider.reportContingency(eventOf(documents), ctx())
    expect(refused).toMatchObject({
      outcome: FiscalContingencyReportOutcome.REJECTED,
      reason: '020'
    })
  })

  it('sends nothing when the event itself is not right, or the credentials are not there', async () => {
    const before = authority.stats.contingencies
    const documents = [stored(await made(8))]
    const bad = await provider.reportContingency(eventOf(documents, { responsible: null }), ctx())
    expect(bad).toEqual({
      outcome: FiscalContingencyReportOutcome.REJECTED,
      reason: SvContingencyRefusals.RESPONSIBLE_REQUIRED,
      neverSent: true
    })
    const noCredentials = await provider.reportContingency(
      eventOf(documents),
      ctx({ credentials: {} })
    )
    expect(noCredentials).toMatchObject({ neverSent: true })
    expect(authority.stats.contingencies).toBe(before)
  })
})
