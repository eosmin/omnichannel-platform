import {
  FiscalBatchConsultState,
  FiscalBatchSendOutcome,
  FiscalContingencyReportOutcome,
  FiscalDeferOutcome,
  FiscalSubmitOutcome
} from '@platform/core/domain'
import type {
  BuiltDocument,
  FiscalBatchRequest,
  FiscalContingencyEvent,
  ProviderContext,
  StoredFiscalDocument
} from '@platform/fiscal/sdk'

import { batchSendBody, classifyBatchConsult, classifyBatchSend, lotCodes } from './sv-batch'
import { buildDocument } from './sv-build'
import {
  SvBatch,
  SvBatchRefusals,
  SvContingency,
  SvCredentialKeys,
  SvProviderDataKeys
} from './sv-constants'
import { svProvider, type SvProvider } from './sv-provider'
import { officialSigner } from './sv-signer'
import {
  FAKE,
  signJws,
  startFakeAuthority,
  verifyJws,
  type FakeAuthority
} from './testing/fake-authority'
import { CONSUMER, ISSUER, sale } from './testing/sv-fixtures'

const ISSUER_OF_FAKE = { ...ISSUER, taxId: '0614-010101-101-1' }
const CREDENTIALS = {
  [SvCredentialKeys.API_PASSWORD]: FAKE.API_PASSWORD,
  [SvCredentialKeys.CERTIFICATE_PASSWORD]: FAKE.KEY_PASSWORD
}
const AUTHORITY_DOWN = { reason: String(SvContingency.REASONS.AUTHORITY_DOWN), motive: null }
const SEND_ID = '5c9d6bcd-bbfd-4b2d-9b5d-00000000b001'

const deferredSale = (n: number, over = {}) =>
  sale({
    correlative: n,
    documentUuid: `1b9d6bcd-bbfd-4b2d-9b5d-${String(n).padStart(12, '0')}`,
    contingency: AUTHORITY_DOWN,
    receiver: CONSUMER,
    ...over
  })

// A document as the lot keeps it: the payload and what the deferral kept (the signature it already has)
const storedOf = (built: BuiltDocument, signed: string | null): StoredFiscalDocument => ({
  documentType: built.documentType,
  externalNumber: null,
  providerData:
    signed === null
      ? null
      : {
          [SvProviderDataKeys.GENERATION_CODE]: 'kept',
          [SvProviderDataKeys.SIGNED_DOCUMENT]: signed
        },
  payload: built.payload
})

const pureDocument = (n: number): StoredFiscalDocument => {
  const built = buildDocument(deferredSale(n))
  return storedOf(built, signJws(built.payload))
}

const codeOf = (document: StoredFiscalDocument): string =>
  String((document.payload['identificacion'] as { codigoGeneracion: string }).codigoGeneracion)

describe('the documents of a lot, read for sending', () => {
  it('takes from 1 to 100 documents, never 0 and never 101 (the most the authority takes a lot)', () => {
    expect(SvBatch.MAX_DOCUMENTS).toBe(100)
    expect(lotCodes([])).toBeNull()
    expect(lotCodes([pureDocument(1)])).toHaveLength(1)
    const hundred = Array.from({ length: 100 }, (_, i) => pureDocument(i + 1))
    expect(lotCodes(hundred)).toHaveLength(100)
    expect(lotCodes([...hundred, pureDocument(101)])).toBeNull()
  })

  it('refuses a lot that names a document twice or one with no code of the shape', () => {
    const one = pureDocument(1)
    expect(lotCodes([one, one])).toBeNull()
    expect(
      lotCodes([{ ...one, payload: { identificacion: { codigoGeneracion: 'not-a-code' } } }])
    ).toBeNull()
  })

  it('writes the send id in capitals, the tax id without dashes and the signed documents in order', () => {
    const body = batchSendBody('sandbox' as never, '06140101011011', SEND_ID, ['a.b.c', 'd.e.f'])
    expect(body).toEqual({
      ambiente: '00',
      idEnvio: SEND_ID.toUpperCase(),
      version: SvBatch.VERSION,
      nitEmisor: '06140101011011',
      documentos: ['a.b.c', 'd.e.f']
    })
  })
})

describe('the answer to the send of a lot', () => {
  const CODE = 'C86DD410-8BD7-48D3-8908-61B8C46AFE33'

  it('is a reception only with the state RECIBIDO and the code of the lot', () => {
    const answer = classifyBatchSend(200, { estado: 'RECIBIDO', codigoLote: CODE })
    expect(answer).toMatchObject({ kind: 'received', batchCode: CODE })
    expect(classifyBatchSend(200, { estado: 'RECIBIDO' }).kind).not.toBe('received')
    expect(classifyBatchSend(200, { estado: 'RECIBIDO', codigoLote: 'x' }).kind).not.toBe(
      'received'
    )
    // A status of refusal is never a reception, whatever the body says
    expect(classifyBatchSend(400, { estado: 'RECIBIDO', codigoLote: CODE }).kind).not.toBe(
      'received'
    )
  })

  it('tells a bad token, a fault of the moment, a repeated send and a refusal apart', () => {
    expect(classifyBatchSend(401, {}).kind).toBe('token')
    expect(classifyBatchSend(503, {}).kind).toBe('transient')
    expect(classifyBatchSend(400, { estado: 'RECHAZADO', codigoMsg: '004' }).kind).toBe('duplicate')
    expect(classifyBatchSend(400, { estado: 'RECHAZADO', codigoMsg: '094' })).toMatchObject({
      kind: 'rejected',
      code: '094'
    })
  })
})

describe('the answer to the consultation of a lot', () => {
  const documents = [1, 2, 3].map(pureDocument)
  const entry = (index: number, over: Record<string, unknown> = {}) => ({
    version: 2,
    ambiente: '00',
    estado: 'PROCESADO',
    codigoGeneracion: codeOf(documents[index] as StoredFiscalDocument),
    selloRecibido: `SEAL${index}`,
    fhProcesamiento: '14/10/2021 10:36:15',
    codigoMsg: '001',
    observaciones: [],
    index,
    ...over
  })
  const refused = (index: number, code = '802') =>
    entry(index, { estado: 'RECHAZADO', selloRecibido: null, codigoMsg: code })

  it('is not finished when the service answers with neither list', () => {
    expect(classifyBatchConsult(200, { estado: 'PROCESANDO' }, documents)).toEqual({
      kind: 'pending'
    })
  })

  it('gives each document its verdict by the generation code, whatever the order of the answer', () => {
    const answer = classifyBatchConsult(
      200,
      { procesados: [entry(2), entry(0)], rechazados: [refused(1)] },
      documents
    )
    expect(answer.kind).toBe('done')
    if (answer.kind !== 'done') return
    expect(answer.verdicts.map(v => [v.index, v.outcome])).toEqual([
      [2, FiscalSubmitOutcome.ACCEPTED],
      [0, FiscalSubmitOutcome.ACCEPTED],
      [1, FiscalSubmitOutcome.REJECTED]
    ])
    const accepted = answer.verdicts.find(v => v.index === 0)
    expect(accepted).toMatchObject({
      outcome: FiscalSubmitOutcome.ACCEPTED,
      providerData: { [SvProviderDataKeys.RECEPTION_SEAL]: 'SEAL0' }
    })
    // The signature the lot carried stays with the seal
    expect(
      (accepted as { providerData: Record<string, unknown> }).providerData[
        SvProviderDataKeys.SIGNED_DOCUMENT
      ]
    ).toBe(
      (documents[0] as StoredFiscalDocument).providerData?.[SvProviderDataKeys.SIGNED_DOCUMENT]
    )
    expect(answer.verdicts.find(v => v.index === 1)).toMatchObject({
      outcome: FiscalSubmitOutcome.REJECTED,
      reason: '802'
    })
  })

  it("does not believe an answer whose place is not the document's, that repeats one or names one the lot does not hold", () => {
    expect(
      classifyBatchConsult(200, { procesados: [entry(0, { index: 1 })], rechazados: [] }, documents)
    ).toEqual({ kind: 'invalid' })
    expect(
      classifyBatchConsult(200, { procesados: [entry(0), entry(0)], rechazados: [] }, documents)
    ).toEqual({ kind: 'invalid' })
    expect(
      classifyBatchConsult(
        200,
        {
          procesados: [entry(0, { codigoGeneracion: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' })],
          rechazados: []
        },
        documents
      )
    ).toEqual({ kind: 'invalid' })
    // The same document in both lists
    expect(
      classifyBatchConsult(200, { procesados: [entry(0)], rechazados: [refused(0)] }, documents)
    ).toEqual({ kind: 'invalid' })
  })

  it('leaves without a verdict a "processed" with no seal and a refusal that is a fault of the moment', () => {
    const answer = classifyBatchConsult(
      200,
      {
        procesados: [entry(0, { selloRecibido: null })],
        rechazados: [refused(1, '099'), refused(2, '020')]
      },
      documents
    )
    expect(answer).toMatchObject({ kind: 'done' })
    if (answer.kind !== 'done') return
    expect(answer.verdicts.map(v => v.index)).toEqual([2])
  })

  it('reads a bad token and a fault of the server as such', () => {
    expect(classifyBatchConsult(401, {}, documents).kind).toBe('token')
    expect(classifyBatchConsult(502, {}, documents).kind).toBe('transient')
    expect(classifyBatchConsult(400, { estado: 'RECHAZADO' }, documents).kind).toBe('transient')
  })
})

describe('a lot sent to the authority', () => {
  let authority: FakeAuthority
  let provider: SvProvider

  const ctx = (): ProviderContext => ({
    issuer: ISSUER_OF_FAKE,
    credentials: CREDENTIALS,
    idempotencyKey: 'org:batch:1',
    attempt: 1
  })

  beforeAll(async () => {
    authority = await startFakeAuthority()
    provider = svProvider({
      signer: officialSigner({
        baseUrl: authority.baseUrl,
        fetch: (url, init) => fetch(url, init),
        timeoutMs: 2000
      }),
      now: () => Date.parse('2026-11-18T15:00:00.000Z'),
      endpoints: authority.endpoints
    })
  })
  afterAll(async () => {
    await authority.close()
  })
  beforeEach(() => {
    authority.forgetDocuments()
    authority.stats.batches = 0
    authority.stats.batchConsults = 0
    authority.stats.signs = 0
    authority.batchDown = false
    authority.batchPendingConsults = 0
    authority.receptionDown = false
    authority.expireTokens()
  })

  // Documents made in contingency, signed as the deferral signs them, and listed by an event the authority took
  const listed = async (
    count: number,
    receiverOf: (n: number) => Record<string, unknown> = () => ({})
  ): Promise<StoredFiscalDocument[]> => {
    const documents: StoredFiscalDocument[] = []
    for (let n = 1; n <= count; n += 1) {
      const built = await provider.build(deferredSale(n, receiverOf(n)))
      const deferred = await provider.deferDocument(built, ctx())
      if (deferred.outcome !== FiscalDeferOutcome.DEFERRED) throw new Error('not deferred')
      documents.push({
        documentType: built.documentType,
        externalNumber: null,
        providerData: deferred.providerData ?? null,
        payload: built.payload
      })
    }
    const event: FiscalContingencyEvent = {
      eventId: '3c9d6bcd-bbfd-4b2d-9b5d-00000000a001',
      reason: String(SvContingency.REASONS.AUTHORITY_DOWN),
      motive: null,
      startedAt: '2026-11-18T10:00:00.000Z',
      endedAt: '2026-11-18T14:30:00.000Z',
      documents,
      responsible: { name: 'Ana Pérez', idType: '13', idNumber: '012345678' }
    }
    const reported = await provider.reportContingency(event, ctx())
    expect(reported.outcome).toBe(FiscalContingencyReportOutcome.ACCEPTED)
    return documents
  }

  const requestOf = (documents: StoredFiscalDocument[], sendId = SEND_ID): FiscalBatchRequest => ({
    sendId,
    documents
  })

  it('declares the lots in its manifest: 100 documents a lot and 400 lots', () => {
    expect(provider.manifest.contingencyMode?.batch).toEqual({
      maxDocumentsPerBatch: 100,
      maxBatchesPerContingency: 400
    })
  })

  it('is received with a code, carries the documents as they were signed and says the send id in capitals', async () => {
    const documents = await listed(3)
    authority.stats.signs = 0
    const sent = await provider.submitBatch(requestOf(documents), ctx())
    expect(sent.outcome).toBe(FiscalBatchSendOutcome.RECEIVED)
    if (sent.outcome !== FiscalBatchSendOutcome.RECEIVED) return
    expect(sent.batchCode).toMatch(/^[A-F0-9-]{36}$/)
    expect(authority.stats.lastBatch?.sendId).toBe(SEND_ID.toUpperCase())
    // The signature the deferral made goes as it is: nothing is signed again
    expect(authority.stats.signs).toBe(0)
    expect(authority.stats.lastBatch?.documents).toEqual(
      documents.map(d => d.providerData?.[SvProviderDataKeys.SIGNED_DOCUMENT])
    )
    expect(verifyJws(String(authority.stats.lastBatch?.documents[0]))).not.toBeNull()
  })

  it('signs the document that has no signature of its own kept', async () => {
    const documents = await listed(2)
    const bare = documents.map(d => ({ ...d, providerData: null }))
    authority.stats.signs = 0
    const sent = await provider.submitBatch(requestOf(bare), ctx())
    expect(sent.outcome).toBe(FiscalBatchSendOutcome.RECEIVED)
    expect(authority.stats.signs).toBe(2)
  })

  it('takes 100 documents and refuses 101 before anything is sent', async () => {
    const hundred = Array.from({ length: 100 }, (_, i) => pureDocument(i + 1))
    const received = await provider.submitBatch(requestOf(hundred), ctx())
    expect(received.outcome).toBe(FiscalBatchSendOutcome.RECEIVED)
    const before = authority.stats.batches
    const over = await provider.submitBatch(
      requestOf([...hundred, pureDocument(101)], '5c9d6bcd-bbfd-4b2d-9b5d-00000000b002'),
      ctx()
    )
    expect(over).toEqual({
      outcome: FiscalBatchSendOutcome.REJECTED,
      reason: SvBatchRefusals.TOO_MANY_DOCUMENTS,
      neverSent: true
    })
    expect(authority.stats.batches).toBe(before)
  })

  it('refuses an empty lot, a document with no code and a send id that is not a UUID, sending nothing', async () => {
    for (const request of [
      requestOf([]),
      requestOf([{ ...pureDocument(1), payload: {} }]),
      requestOf([pureDocument(1)], 'not-a-uuid')
    ]) {
      const result = await provider.submitBatch(request, ctx())
      expect(result).toMatchObject({ outcome: FiscalBatchSendOutcome.REJECTED, neverSent: true })
    }
    expect(authority.stats.batches).toBe(0)
  })

  it('says a send id the authority holds already, and a second lot under another id goes through', async () => {
    const documents = [pureDocument(1)]
    expect((await provider.submitBatch(requestOf(documents), ctx())).outcome).toBe(
      FiscalBatchSendOutcome.RECEIVED
    )
    const again = await provider.submitBatch(requestOf(documents), ctx())
    expect(again).toMatchObject({
      outcome: FiscalBatchSendOutcome.REJECTED,
      reason: SvBatchRefusals.SEND_ID_ALREADY_USED
    })
    const other = await provider.submitBatch(
      requestOf(documents, '5c9d6bcd-bbfd-4b2d-9b5d-00000000b003'),
      ctx()
    )
    expect(other.outcome).toBe(FiscalBatchSendOutcome.RECEIVED)
  })

  it('says unavailable when the authority does not answer, and refuses credentials that are not complete', async () => {
    authority.batchDown = true
    expect((await provider.submitBatch(requestOf([pureDocument(1)]), ctx())).outcome).toBe(
      FiscalBatchSendOutcome.UNAVAILABLE
    )
    authority.batchDown = false
    const wrong = await provider.submitBatch(requestOf([pureDocument(1)]), {
      ...ctx(),
      credentials: {}
    })
    expect(wrong).toMatchObject({ outcome: FiscalBatchSendOutcome.REJECTED, neverSent: true })
  })

  it('is asked about until it is finished and then gives a verdict to each document, the accepted ones with their seal', async () => {
    const documents = await listed(3, n =>
      n === 2 ? { receiver: { ...CONSUMER, name: 'Ana', taxId: FAKE.REJECT } } : {}
    )
    // The receiver that the fake refuses is the one with that number; the others are processed
    const sent = await provider.submitBatch(requestOf(documents), ctx())
    if (sent.outcome !== FiscalBatchSendOutcome.RECEIVED) throw new Error('not received')
    authority.batchPendingConsults = 2
    const request = requestOf(documents)
    expect((await provider.consultBatch(sent.batchCode, request, ctx())).state).toBe(
      FiscalBatchConsultState.PENDING
    )
    expect((await provider.consultBatch(sent.batchCode, request, ctx())).state).toBe(
      FiscalBatchConsultState.PENDING
    )
    const done = await provider.consultBatch(sent.batchCode, request, ctx())
    expect(done.state).toBe(FiscalBatchConsultState.DONE)
    if (done.state !== FiscalBatchConsultState.DONE) return
    expect(done.verdicts).toHaveLength(3)
    expect(done.verdicts.map(v => v.index).sort()).toEqual([0, 1, 2])
    for (const verdict of done.verdicts) {
      if (verdict.outcome === FiscalSubmitOutcome.ACCEPTED) {
        expect(verdict.providerData?.[SvProviderDataKeys.RECEPTION_SEAL]).toEqual(
          expect.stringMatching(/^[A-F0-9]{40}$/)
        )
      }
    }
    // Asked again after it finished: the same verdicts (the authority processed it once)
    const again = await provider.consultBatch(sent.batchCode, request, ctx())
    expect(again).toEqual(done)
  })

  it('refuses a document of a lot that no event listed, by its place in the lot', async () => {
    const documents = await listed(2)
    const stranger = pureDocument(50)
    const request = requestOf([...documents, stranger])
    const sent = await provider.submitBatch(request, ctx())
    if (sent.outcome !== FiscalBatchSendOutcome.RECEIVED) throw new Error('not received')
    const done = await provider.consultBatch(sent.batchCode, request, ctx())
    if (done.state !== FiscalBatchConsultState.DONE) throw new Error('not done')
    const byIndex = new Map(done.verdicts.map(v => [v.index, v]))
    expect(byIndex.get(0)?.outcome).toBe(FiscalSubmitOutcome.ACCEPTED)
    expect(byIndex.get(1)?.outcome).toBe(FiscalSubmitOutcome.ACCEPTED)
    expect(byIndex.get(2)).toMatchObject({ outcome: FiscalSubmitOutcome.REJECTED, reason: '013' })
  })

  it('says unavailable when the authority does not answer about a lot or does not know its code', async () => {
    const documents = [pureDocument(1)]
    const request = requestOf(documents)
    const sent = await provider.submitBatch(request, ctx())
    if (sent.outcome !== FiscalBatchSendOutcome.RECEIVED) throw new Error('not received')
    authority.batchDown = true
    expect((await provider.consultBatch(sent.batchCode, request, ctx())).state).toBe(
      FiscalBatchConsultState.UNAVAILABLE
    )
    authority.batchDown = false
    expect(
      (await provider.consultBatch('AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', request, ctx())).state
    ).toBe(FiscalBatchConsultState.UNAVAILABLE)
    expect((await provider.consultBatch('not-a-code', request, ctx())).state).toBe(
      FiscalBatchConsultState.UNAVAILABLE
    )
  })
})
