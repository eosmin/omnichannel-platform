import {
  FiscalConsultState,
  FiscalEnvironment,
  FiscalSubmitOutcome,
  FiscalVoidConsultState,
  FiscalVoidKind
} from '@platform/core/domain'
import type {
  BuiltDocument,
  FiscalVoidDetails,
  ProviderContext,
  StoredFiscalDocument
} from '@platform/fiscal/sdk'

import {
  SvCredentialKeys,
  SvProviderDataKeys,
  SvRejectionReasons,
  SvVoidRefusals
} from './sv-constants'
import { SvTransportError } from './sv-http'
import { svProvider, type SvProvider } from './sv-provider'
import { officialSigner } from './sv-signer'
import { startFakeAuthority, FAKE, verifyJws, type FakeAuthority } from './testing/fake-authority'
import { BUSINESS, CONSUMER, ISSUER, sale } from './testing/sv-fixtures'

// The client against a server of our own that plays the authority and its signing service (testing/fake-authority.ts). Nothing here reaches
// the real authority.

const ISSUER_OF_FAKE = { ...ISSUER, taxId: '0614-010101-101-1' }
const CREDENTIALS = {
  [SvCredentialKeys.API_PASSWORD]: FAKE.API_PASSWORD,
  [SvCredentialKeys.CERTIFICATE_PASSWORD]: FAKE.KEY_PASSWORD
}
const ctxOf = (over: Partial<ProviderContext> = {}): ProviderContext => ({
  issuer: ISSUER_OF_FAKE,
  credentials: CREDENTIALS,
  idempotencyKey: 'org:doc:1',
  attempt: 1,
  ...over
})

describe('the client of the authority', () => {
  let authority: FakeAuthority
  let clock = 0
  let provider: SvProvider

  const make = (over: { receptionTimeoutMs?: number; now?: () => number } = {}): SvProvider =>
    svProvider({
      signer: officialSigner({
        baseUrl: authority.baseUrl,
        fetch: (url, init) => fetch(url, init),
        timeoutMs: 2000
      }),
      now: () => clock,
      endpoints: authority.endpoints,
      ...over
    })

  beforeAll(async () => {
    authority = await startFakeAuthority()
  })
  afterAll(async () => {
    await authority.close()
  })
  beforeEach(() => {
    clock = 1_000_000
    authority.forgetDocuments()
    authority.signerDown = false
    authority.loginMode = 'normal'
    authority.stats.capturedBodies.length = 0
    authority.expireTokens()
    for (const key of Object.keys(authority.stats) as (keyof typeof authority.stats)[]) {
      const value = authority.stats[key]
      if (typeof value === 'number') (authority.stats as Record<string, unknown>)[key] = 0
    }
    authority.stats.userAgents.clear()
    authority.stats.environments.clear()
    provider = make()
  })

  // A document of the sale, for a receiver the fake authority reads by number
  const built = async (taxId: string | null, n = 1): Promise<BuiltDocument> =>
    provider.build(
      sale({
        correlative: n,
        documentUuid: `1b9d6bcd-bbfd-4b2d-9b5d-${String(n).padStart(12, '0')}`,
        receiver: taxId === null ? CONSUMER : { ...CONSUMER, name: 'Ana', taxId }
      })
    )

  describe('a document the authority accepts', () => {
    it('is signed, sent with the token and the generic user agent, and kept with what the authority gave', async () => {
      const document = await built(null)
      const result = await provider.submit(document, ctxOf())
      expect(result.outcome).toBe(FiscalSubmitOutcome.ACCEPTED)
      if (result.outcome !== FiscalSubmitOutcome.ACCEPTED) return
      const control = (document.payload['identificacion'] as { numeroControl: string })
        .numeroControl
      expect(result.externalNumber).toBe(control)
      expect(result.providerData).toMatchObject({
        [SvProviderDataKeys.GENERATION_CODE]: '1B9D6BCD-BBFD-4B2D-9B5D-000000000001',
        [SvProviderDataKeys.CONTROL_NUMBER]: control,
        [SvProviderDataKeys.ISSUE_DATE]: '2026-11-16',
        [SvProviderDataKeys.PROCESSED_AT]: '17/11/2026 09:00:00',
        [SvProviderDataKeys.OBSERVATIONS]: []
      })
      expect(String(result.providerData?.[SvProviderDataKeys.RECEPTION_SEAL])).toHaveLength(40)
      // What was sent is what was built, signed: the authority verified the signature and read the same document
      const jws = String(result.providerData?.[SvProviderDataKeys.SIGNED_DOCUMENT])
      expect(verifyJws(jws)).toEqual(JSON.parse(JSON.stringify(document.payload)))
      expect(authority.stats.lastJws).toBe(jws)
      expect([...authority.stats.userAgents]).toEqual(['PlataformaOmnicanal/1.0'])
      expect([...authority.stats.environments]).toEqual(['00'])
    })

    it('keeps the observations of the authority when it accepts with them', async () => {
      const result = await provider.submit(await built(FAKE.OBSERVED, 2), ctxOf())
      expect(result.outcome).toBe(FiscalSubmitOutcome.ACCEPTED)
      if (result.outcome === FiscalSubmitOutcome.ACCEPTED) {
        expect(result.providerData?.[SvProviderDataKeys.OBSERVATIONS]).toEqual([
          'identificacion.fecEmi Difiere de la fecha de envío.'
        ])
      }
    })

    it('sends the production environment code for a production issuer', async () => {
      const result = await provider.submit(
        await built(null, 3),
        ctxOf({ issuer: { ...ISSUER_OF_FAKE, environment: FiscalEnvironment.PRODUCTION } })
      )
      expect(result.outcome).toBe(FiscalSubmitOutcome.ACCEPTED)
      expect([...authority.stats.environments]).toEqual(['01'])
    })

    it('sends a tax credit document the same way', async () => {
      const taxCredit = await provider.build(
        sale({
          receiver: { ...BUSINESS, taxId: '0614-020202-102-3' },
          correlative: 4,
          documentUuid: '2b9d6bcd-bbfd-4b2d-9b5d-000000000004'
        })
      )
      expect(taxCredit.documentType).toBe('03')
      expect((await provider.submit(taxCredit, ctxOf())).outcome).toBe(FiscalSubmitOutcome.ACCEPTED)
    })
  })

  describe('the token', () => {
    it('is asked for once for many documents, and by one login when they arrive together', async () => {
      const documents = await Promise.all([1, 2, 3, 4, 5].map(n => built(null, 10 + n)))
      const results = await Promise.all(
        documents.map(document => provider.submit(document, ctxOf()))
      )
      expect(results.every(result => result.outcome === FiscalSubmitOutcome.ACCEPTED)).toBe(true)
      expect(authority.stats.logins).toBe(1)
      expect(authority.stats.receptions).toBe(5)
    })

    it('is renewed before it ends: at 80 % of its two days in the sandbox', async () => {
      await provider.submit(await built(null, 20), ctxOf())
      clock += 0.79 * 48 * 60 * 60 * 1000
      await provider.submit(await built(null, 21), ctxOf())
      expect(authority.stats.logins).toBe(1)
      clock += 0.02 * 48 * 60 * 60 * 1000
      await provider.submit(await built(null, 22), ctxOf())
      expect(authority.stats.logins).toBe(2)
    })

    it('is asked for again, once, when the authority does not accept the one it has', async () => {
      await provider.submit(await built(null, 30), ctxOf())
      authority.expireTokens()
      const result = await provider.submit(await built(null, 31), ctxOf())
      expect(result.outcome).toBe(FiscalSubmitOutcome.ACCEPTED)
      expect(authority.stats.logins).toBe(2)
    })
  })

  describe('what is not a verdict on the credentials', () => {
    it('a rate limit or a gateway error at the login is a fault of the moment: no memory of a refused password, and the next call logs in', async () => {
      authority.loginMode = 'rateLimited'
      const first = await provider.submit(await built(null, 100), ctxOf())
      expect(first.outcome).toBe(FiscalSubmitOutcome.UNAVAILABLE)
      authority.loginMode = 'normal'
      const next = await provider.submit(await built(null, 101), ctxOf())
      expect(next.outcome).toBe(FiscalSubmitOutcome.ACCEPTED)
      expect(authority.stats.wrongLogins).toBe(0)
    })

    it('a redirect is never followed: the password does not travel to the address it points at', async () => {
      authority.loginMode = 'redirect'
      const result = await provider.submit(await built(null, 102), ctxOf())
      expect(result.outcome).toBe(FiscalSubmitOutcome.UNAVAILABLE)
      expect(authority.stats.capturedBodies).toEqual([])
    })
  })

  describe('the credentials', () => {
    it('refuses a password the authority rejects, and does not send it again for fifteen minutes (three wrong logins lock the user)', async () => {
      const wrong = ctxOf({
        credentials: { ...CREDENTIALS, [SvCredentialKeys.API_PASSWORD]: 'Wrong-Password-1!' }
      })
      const first = await provider.submit(await built(null, 40), wrong)
      expect(first).toMatchObject({
        outcome: FiscalSubmitOutcome.REJECTED,
        reason: SvRejectionReasons.CREDENTIALS_REJECTED,
        neverSent: true
      })
      expect(authority.stats.wrongLogins).toBe(1)
      for (let i = 0; i < 5; i += 1) await provider.submit(await built(null, 41 + i), wrong)
      expect(authority.stats.wrongLogins).toBe(1)
      // After the memory ends one more try is made: a person may have fixed the password
      clock += 16 * 60 * 1000
      await provider.submit(await built(null, 50), wrong)
      expect(authority.stats.wrongLogins).toBe(2)
    })

    it('a corrected password is a new key: it logs in at once, whatever the memory of the wrong one', async () => {
      await provider.submit(
        await built(null, 60),
        ctxOf({
          credentials: { ...CREDENTIALS, [SvCredentialKeys.API_PASSWORD]: 'Wrong-Password-1!' }
        })
      )
      const result = await provider.submit(await built(null, 61), ctxOf())
      expect(result.outcome).toBe(FiscalSubmitOutcome.ACCEPTED)
    })

    it('refuses a password of the private key that does not open the certificate, as a refusal that sent nothing', async () => {
      const result = await provider.submit(
        await built(null, 70),
        ctxOf({
          credentials: { ...CREDENTIALS, [SvCredentialKeys.CERTIFICATE_PASSWORD]: 'Wrong-Key-0000' }
        })
      )
      expect(result).toMatchObject({
        outcome: FiscalSubmitOutcome.REJECTED,
        reason: SvRejectionReasons.SIGNING_CREDENTIALS_REJECTED,
        neverSent: true
      })
      expect(authority.stats.receptions).toBe(0)
    })

    it('does not send the password of the private key to the signer while the authority cannot be logged into', async () => {
      authority.loginMode = 'rateLimited'
      expect((await provider.submit(await built(null, 72), ctxOf())).outcome).toBe(
        FiscalSubmitOutcome.UNAVAILABLE
      )
      expect(authority.stats.signs).toBe(0)
    })

    it('asks a person for the credentials that are missing, without calling anything', async () => {
      const result = await provider.submit(await built(null, 71), ctxOf({ credentials: {} }))
      expect(result).toMatchObject({
        outcome: FiscalSubmitOutcome.REJECTED,
        reason: SvRejectionReasons.CREDENTIALS_INCOMPLETE,
        neverSent: true
      })
      expect(authority.stats.signs + authority.stats.logins).toBe(0)
    })

    it('never puts a password or a token in what it answers', async () => {
      const outcomes = [
        await provider.submit(await built(null, 80), ctxOf()),
        await provider.submit(await built(FAKE.REJECT, 81), ctxOf()),
        await provider.submit(
          await built(null, 82),
          ctxOf({
            credentials: { ...CREDENTIALS, [SvCredentialKeys.API_PASSWORD]: 'Wrong-Password-1!' }
          })
        ),
        await provider.submit(
          await built(null, 83),
          ctxOf({
            credentials: {
              ...CREDENTIALS,
              [SvCredentialKeys.CERTIFICATE_PASSWORD]: 'Wrong-Key-0000'
            }
          })
        )
      ]
      const text = JSON.stringify(outcomes)
      for (const secret of [
        FAKE.API_PASSWORD,
        FAKE.KEY_PASSWORD,
        'Wrong-Password-1!',
        'Wrong-Key-0000',
        'fake-token'
      ]) {
        expect(text).not.toContain(secret)
      }
    })
  })

  describe('a document the authority does not accept, or does not answer', () => {
    it('is refused with the code of the authority and its answer kept', async () => {
      const result = await provider.submit(await built(FAKE.REJECT, 90), ctxOf())
      expect(result).toMatchObject({ outcome: FiscalSubmitOutcome.REJECTED, reason: '020' })
      if (result.outcome === FiscalSubmitOutcome.REJECTED)
        expect(result.response).toMatchObject({ estado: 'RECHAZADO', codigoMsg: '020' })
    })

    it('is unavailable when the authority is down, and when it does not answer in time', async () => {
      expect((await provider.submit(await built(FAKE.DOWN, 91), ctxOf())).outcome).toBe(
        FiscalSubmitOutcome.UNAVAILABLE
      )
      const quick = make({ receptionTimeoutMs: 150 })
      expect((await quick.submit(await built(FAKE.SLOW, 92), ctxOf())).outcome).toBe(
        FiscalSubmitOutcome.UNAVAILABLE
      )
    })

    it('is unavailable when the signing service is down, and nothing reaches the authority', async () => {
      authority.signerDown = true
      expect((await provider.submit(await built(null, 93), ctxOf())).outcome).toBe(
        FiscalSubmitOutcome.UNAVAILABLE
      )
      expect(authority.stats.receptions).toBe(0)
    })

    it('finds a document whose answer was lost: it asks before it sends again, and the document is not made twice', async () => {
      const document = await built(FAKE.LOST, 94)
      expect((await provider.submit(document, ctxOf())).outcome).toBe(
        FiscalSubmitOutcome.UNAVAILABLE
      )
      const found = await provider.consult(document, ctxOf({ attempt: 2 }))
      expect(found.state).toBe(FiscalConsultState.ACCEPTED)
      if (found.state === FiscalConsultState.ACCEPTED) {
        expect(found.externalNumber).toBe(
          (document.payload['identificacion'] as { numeroControl: string }).numeroControl
        )
        expect(String(found.providerData?.[SvProviderDataKeys.RECEPTION_SEAL])).toHaveLength(40)
      }
      expect(authority.stats.receptions).toBe(1)
    })

    it('a document the authority already has is asked about, not refused: the answer of its first sending was lost', async () => {
      const document = await built(null, 110)
      expect((await provider.submit(document, ctxOf())).outcome).toBe(FiscalSubmitOutcome.ACCEPTED)
      // The platform did not hear: it sends the same document again and the authority says it is already there
      const again = await provider.submit(document, ctxOf({ attempt: 2 }))
      expect(again.outcome).toBe(FiscalSubmitOutcome.ACCEPTED)
      expect(authority.stats.receptions).toBe(2)
      expect(authority.stats.consults).toBe(1)
    })

    it('does not mark a document refused because the authority says it is already there and cannot say what it has: the queue asks again', async () => {
      const result = await provider.submit(await built(FAKE.GHOST, 113), ctxOf())
      expect(result.outcome).toBe(FiscalSubmitOutcome.UNAVAILABLE)
    })

    it('keeps the signed document it sent when the authority says it is already there, and none for one found later by consulting', async () => {
      const document = await built(null, 111)
      const first = await provider.submit(document, ctxOf())
      expect(first.outcome).toBe(FiscalSubmitOutcome.ACCEPTED)
      const sentJws = authority.stats.lastJws
      const again = await provider.submit(document, ctxOf({ attempt: 2 }))
      expect(again.outcome).toBe(FiscalSubmitOutcome.ACCEPTED)
      if (again.outcome === FiscalSubmitOutcome.ACCEPTED) {
        expect(again.providerData?.[SvProviderDataKeys.SIGNED_DOCUMENT]).toBe(sentJws)
      }
      // Found later by a consultation: not signed again (a renewed certificate would sign what the authority never received)
      const found = await provider.consult(document, ctxOf({ attempt: 3 }))
      expect(found.state).toBe(FiscalConsultState.ACCEPTED)
      if (found.state === FiscalConsultState.ACCEPTED) {
        expect(found.providerData).not.toHaveProperty(SvProviderDataKeys.SIGNED_DOCUMENT)
      }
    })

    it('refuses a document whose control number is not one, before it spends a login or a signature', async () => {
      const document = await built(null, 112)
      const broken = {
        ...document,
        payload: {
          ...document.payload,
          identificacion: {
            ...(document.payload['identificacion'] as object),
            numeroControl: 'DTE-01-X'
          }
        }
      }
      expect(await provider.submit(broken, ctxOf())).toMatchObject({
        outcome: FiscalSubmitOutcome.REJECTED,
        reason: SvRejectionReasons.DOCUMENT_INCOMPLETE
      })
      expect(authority.stats.signs + authority.stats.logins).toBe(0)
    })

    it('says it does not know a document the authority never received', async () => {
      const found = await provider.consult(await built(null, 95), ctxOf())
      expect(found.state).toBe(FiscalConsultState.UNKNOWN)
    })

    it('does not answer a consultation it could not make because the authority cannot be reached, so the queue asks again and never sends a document that may be there', async () => {
      // What it cannot ask for lack of credentials it leaves to `submit`, which says exactly what is missing
      expect(
        (await provider.consult(await built(null, 96), ctxOf({ credentials: {} }))).state
      ).toBe(FiscalConsultState.UNKNOWN)
      const down = svProvider({
        signer: officialSigner({
          baseUrl: authority.baseUrl,
          fetch: (url, init) => fetch(url, init),
          timeoutMs: 500
        }),
        now: () => clock,
        endpoints: {
          ...authority.endpoints,
          [FiscalEnvironment.SANDBOX]: {
            ...authority.endpoints[FiscalEnvironment.SANDBOX],
            baseUrl: 'http://127.0.0.1:1'
          }
        }
      })
      // The authority cannot be reached: it is no answer, and the queue asks again
      await expect(down.consult(await built(null, 97), ctxOf())).rejects.toBeInstanceOf(
        SvTransportError
      )
    })
  })

  describe('the addresses', () => {
    it('are the ones of the authority when nothing is overridden, with no trailing slash, and the specs never reach them', async () => {
      const seen: string[] = []
      const watching = svProvider({
        signer: { sign: () => Promise.resolve({ kind: 'unavailable' as const }) },
        fetch: url => {
          seen.push(url)
          return Promise.resolve({ status: 503, text: () => Promise.resolve('') })
        }
      })
      const document = await watching.build(sale({ receiver: CONSUMER }))
      await watching.consult(document, ctxOf()).catch(() => undefined)
      await watching
        .consult(
          document,
          ctxOf({ issuer: { ...ISSUER_OF_FAKE, environment: FiscalEnvironment.PRODUCTION } })
        )
        .catch(() => undefined)
      expect(seen).toEqual([
        'https://apitest.dtes.mh.gob.sv/seguridad/auth',
        'https://api.dtes.mh.gob.sv/seguridad/auth'
      ])
    })
  })

  describe('the invalidation of an accepted document', () => {
    // Inside the window of the documents these specs make (2026-11-16)
    const INSIDE = () => Date.parse('2026-11-18T15:00:00.000Z')
    const RESCISSION: FiscalVoidDetails = {
      kind: FiscalVoidKind.RESCISSION,
      responsible: { name: 'Ana Pérez', idType: '13', idNumber: '012345678' },
      requester: { name: 'Luis Gómez', idType: '36', idNumber: '06140101011011' }
    }
    // An accepted document as core keeps it
    const accepted = async (taxId: string | null, n = 1): Promise<StoredFiscalDocument> => {
      const document = await built(taxId, n)
      const result = await provider.submit(document, ctxOf({ idempotencyKey: `sub:${n}` }))
      if (result.outcome !== FiscalSubmitOutcome.ACCEPTED) throw new Error('not accepted')
      return {
        documentType: document.documentType,
        externalNumber: result.externalNumber,
        providerData: result.providerData ?? null,
        payload: document.payload
      }
    }
    // A request of its own for each call: the key is the one core makes from the document, so two documents never share an event
    let requests = 0
    const vctx = (over: Partial<ProviderContext> = {}): ProviderContext =>
      ctxOf({ idempotencyKey: `void:${(requests += 1)}`, ...over })
    beforeEach(() => {
      provider = make({ now: INSIDE })
    })

    it('sends the signed event with the token and the generic user agent, and says it is voided', async () => {
      const stored = await accepted(null)
      const result = await provider.void(stored, 'Datos equivocados', vctx(), RESCISSION)
      expect(result.voided).toBe(true)
      expect(result.response).toMatchObject({ estado: 'PROCESADO' })
      expect(authority.stats.invalidations).toBe(1)
      expect(authority.stats.userAgents.has('PlataformaOmnicanal/1.0')).toBe(true)
      expect(authority.stats.lastEvent).toMatchObject({
        documento: { tipoDte: '01', codigoGeneracionR: null },
        motivo: { tipoAnulacion: 2, motivoAnulacion: 'Datos equivocados' }
      })
      // Neither password travels back in what core keeps
      expect(JSON.stringify(result)).not.toContain(FAKE.API_PASSWORD)
      expect(JSON.stringify(result)).not.toContain(FAKE.KEY_PASSWORD)
    })

    it('answers a consultation with the state the authority has', async () => {
      const stored = await accepted(null)
      expect((await provider.consultVoid(stored, vctx())).state).toBe(
        FiscalVoidConsultState.NOT_VOIDED
      )
      await provider.void(stored, 'Datos equivocados', vctx(), RESCISSION)
      const after = await provider.consultVoid(stored, vctx())
      expect(after.state).toBe(FiscalVoidConsultState.VOIDED)
      expect(after.response).toMatchObject({ estado: 'INVALIDADO' })
    })

    it('says it does not know when the document is not at the authority or cannot be read', async () => {
      const stored = await accepted(null)
      authority.forgetDocuments()
      expect((await provider.consultVoid(stored, vctx())).state).toBe(
        FiscalVoidConsultState.UNKNOWN
      )
      expect((await provider.consultVoid({ ...stored, providerData: null }, vctx())).state).toBe(
        FiscalVoidConsultState.UNKNOWN
      )
    })

    it('gives the refusal of the authority with its code, and voids a document only once', async () => {
      const stored = await accepted(null)
      expect((await provider.void(stored, 'a', vctx(), RESCISSION)).voided).toBe(true)
      const again = await provider.void(stored, 'a', ctxOf({ idempotencyKey: 'other' }), RESCISSION)
      expect(again).toMatchObject({ voided: false, reason: '053' })
      const refused = await accepted(null, 2)
      const answer = await provider.void(refused, 'a', vctx(), {
        ...RESCISSION,
        requester: { name: 'Luis', idType: '36', idNumber: FAKE.REJECT }
      })
      // The refusal is the authority's own: it starts the window to correct and send the event again (D14b)
      expect(answer).toMatchObject({ voided: false, reason: '020', byAuthority: true })
    })

    it('throws when the authority does not answer, and a consultation finds what it did', async () => {
      const down = await accepted(null, 3)
      const details = {
        ...RESCISSION,
        requester: { name: 'Luis', idType: '36', idNumber: FAKE.DOWN }
      }
      await expect(provider.void(down, 'a', vctx(), details)).rejects.toBeInstanceOf(
        SvTransportError
      )
      // The next attempt finds it up
      expect((await provider.void(down, 'a', vctx(), details)).voided).toBe(true)

      const lost = await accepted(null, 4)
      const lostDetails = {
        ...RESCISSION,
        requester: { name: 'Luis', idType: '36', idNumber: FAKE.LOST }
      }
      await expect(provider.void(lost, 'a', vctx(), lostDetails)).rejects.toBeDefined()
      expect((await provider.consultVoid(lost, ctxOf({ attempt: 2 }))).state).toBe(
        FiscalVoidConsultState.VOIDED
      )
    })

    it('recovers a void whose answer was lost when the same request is sent again', async () => {
      const lost = await accepted(null, 7)
      const details = {
        ...RESCISSION,
        requester: { name: 'Luis', idType: '36', idNumber: FAKE.LOST }
      }
      const ctx = ctxOf({ idempotencyKey: 'k:lost' })
      await expect(provider.void(lost, 'a', ctx, details)).rejects.toBeDefined()
      // The authority answers the second one that it has this event (code 4): it is asked what it holds, and it holds the void
      const again = await provider.void(lost, 'a', { ...ctx, attempt: 2 }, details)
      expect(again.voided).toBe(true)
      expect(again.response).toMatchObject({ estado: 'INVALIDADO' })
    })

    it('does not believe an answer about another document', async () => {
      const stored = await accepted(null, 8)
      await provider.void(stored, 'a', vctx(), RESCISSION)
      const other = svProvider({
        signer: officialSigner({
          baseUrl: authority.baseUrl,
          fetch: (url, init) => fetch(url, init),
          timeoutMs: 2000
        }),
        now: INSIDE,
        endpoints: authority.endpoints,
        fetch: async (url, init) => {
          const real = await fetch(url, init)
          if (!String(url).endsWith('/fesv/recepcion/consultadte')) return real
          const body = (await real.json()) as Record<string, unknown>
          return new Response(JSON.stringify({ ...body, codigoGeneracion: 'OTHER-DOCUMENT' }), {
            status: real.status
          })
        }
      })
      expect((await other.consultVoid(stored, vctx())).state).toBe(FiscalVoidConsultState.UNKNOWN)
    })

    it('makes the same event for the same request and another one for another request', async () => {
      const stored = await accepted(null)
      const codeOf = (): unknown =>
        (authority.stats.lastEvent?.['identificacion'] as { codigoGeneracion: string })
          .codigoGeneracion
      await provider.void(stored, 'a', ctxOf({ idempotencyKey: 'k:1' }), RESCISSION)
      const first = codeOf()
      await provider.void(stored, 'a', ctxOf({ idempotencyKey: 'k:1', attempt: 2 }), RESCISSION)
      expect(codeOf()).toBe(first)
      await provider.void(stored, 'a', ctxOf({ idempotencyKey: 'k:2' }), RESCISSION)
      expect(codeOf()).not.toBe(first)
    })

    describe('the event that is corrected and sent again (Normativa DTE, apartado 10)', () => {
      const EVENT = { code: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', at: '2026-11-18T15:00:00.000Z' }
      const identification = (): { codigoGeneracion: string; fecEmi: string; horEmi: string } =>
        authority.stats.lastEvent?.['identificacion'] as {
          codigoGeneracion: string
          fecEmi: string
          horEmi: string
        }

      it('carries the code core gives it, whatever the request says: a corrected request is the same event', async () => {
        const stored = await accepted(null, 10)
        const refused = await provider.void(stored, 'a', vctx({ voidEvent: EVENT }), {
          ...RESCISSION,
          requester: { name: 'Luis', idType: '36', idNumber: FAKE.REJECT }
        })
        expect(refused).toMatchObject({ voided: false, byAuthority: true })
        expect(identification().codigoGeneracion).toBe(EVENT.code)
        // Corrected (another reason, another key) and sent again: the authority took no event with that code, so it takes this one
        const again = await provider.void(
          stored,
          'corrected reason',
          vctx({ voidEvent: EVENT }),
          RESCISSION
        )
        expect(again.voided).toBe(true)
        expect(identification().codigoGeneracion).toBe(EVENT.code)
      })

      it('keeps the date and the hour of the first attempt when the retry is another day', async () => {
        const stored = await accepted(null, 11)
        provider = make({ now: () => Date.parse('2026-11-19T15:00:00.000Z') })
        await provider.void(stored, 'a', vctx({ voidEvent: EVENT }), RESCISSION)
        expect(identification()).toMatchObject({ fecEmi: '2026-11-18', horEmi: '09:00:00' })
      })

      it('counts the deadline from the moment of the first attempt, not from the retry', async () => {
        const stored = await accepted(null, 12)
        provider = make({ now: () => Date.parse('2028-01-01T15:00:00.000Z') })
        expect(await provider.void(stored, 'a', vctx(), RESCISSION)).toMatchObject({
          voided: false,
          reason: SvVoidRefusals.DEADLINE_PASSED
        })
        const retried = await provider.void(stored, 'a', vctx({ voidEvent: EVENT }), RESCISSION)
        expect(retried.voided).toBe(true)
      })

      it('says the code was refused only when the authority names the code, and not for another refusal', async () => {
        const first = await accepted(null, 13)
        const second = await accepted(null, 14)
        expect(
          (await provider.void(first, 'a', vctx({ voidEvent: EVENT }), RESCISSION)).voided
        ).toBe(true)
        // Another document sent with a code the authority holds already (code 4 naming identificacion.codigoGeneracion)
        const clash = await provider.void(second, 'a', vctx({ voidEvent: EVENT }), RESCISSION)
        expect(clash).toMatchObject({
          voided: false,
          reason: '004',
          byAuthority: true,
          eventCodeRefused: true
        })
        const other = await accepted(null, 15)
        const refused = await provider.void(
          other,
          'a',
          vctx({
            voidEvent: { code: 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB', at: EVENT.at }
          }),
          { ...RESCISSION, requester: { name: 'Luis', idType: '36', idNumber: FAKE.REJECT } }
        )
        expect(refused).toMatchObject({ voided: false, reason: '020', byAuthority: true })
        expect(refused.eventCodeRefused).toBeUndefined()
      })
    })

    it('needs the replacement the authority has for a correction', async () => {
      const stored = await accepted(null, 1)
      const replacement = await accepted(null, 2)
      const correction = { ...RESCISSION, kind: FiscalVoidKind.CORRECTION }
      // Without it, nothing is sent
      const before = authority.stats.invalidations
      expect(await provider.void(stored, 'a', vctx(), correction)).toEqual({
        voided: false,
        reason: SvVoidRefusals.REPLACEMENT_REQUIRED
      })
      expect(authority.stats.invalidations).toBe(before)
      // With it, the event carries its generation code
      const answer = await provider.void(stored, 'a', vctx(), { ...correction, replacement })
      expect(answer.voided).toBe(true)
      expect(authority.stats.lastEvent?.['documento']).toMatchObject({
        codigoGeneracionR: (replacement.payload['identificacion'] as { codigoGeneracion: string })
          .codigoGeneracion
      })
      // A replacement the authority does not have is refused by it
      const other = await accepted(null, 5)
      const ghost = await built(null, 6)
      const ghostStored: StoredFiscalDocument = {
        documentType: ghost.documentType,
        externalNumber: 'x',
        providerData: replacement.providerData,
        payload: ghost.payload
      }
      expect(
        await provider.void(other, 'a', vctx(), { ...correction, replacement: ghostStored })
      ).toMatchObject({ voided: false, reason: '054' })
    })

    it('sends nothing when the window is over, and says it with a code', async () => {
      const stored = await accepted(null)
      // The fake authority seals on 17 November 2026: three months from the seal end on 17 February 2027
      provider = make({ now: () => Date.parse('2027-02-18T12:00:00.000Z') })
      const before = authority.stats.invalidations
      expect(await provider.void(stored, 'a', vctx(), RESCISSION)).toEqual({
        voided: false,
        reason: SvVoidRefusals.DEADLINE_PASSED
      })
      expect(authority.stats.invalidations).toBe(before)
    })

    it('does not call the authority with a password it refused, and does not sign', async () => {
      const stored = await accepted(null)
      const signsBefore = authority.stats.signs
      const wrong = { ...CREDENTIALS, [SvCredentialKeys.API_PASSWORD]: 'wrong-password' }
      const answer = await provider.void(stored, 'a', vctx({ credentials: wrong }), RESCISSION)
      expect(answer).toEqual({ voided: false, reason: SvVoidRefusals.CREDENTIALS_REJECTED })
      expect(authority.stats.signs).toBe(signsBefore)
      expect(JSON.stringify(answer)).not.toContain('wrong-password')
      const none = await provider.void(stored, 'a', vctx({ credentials: {} }), RESCISSION)
      expect(none).toEqual({ voided: false, reason: SvVoidRefusals.CREDENTIALS_INCOMPLETE })
    })

    it('throws, and does not tell the person the document is refused, when the signer is down', async () => {
      const stored = await accepted(null)
      authority.signerDown = true
      await expect(provider.void(stored, 'a', vctx(), RESCISSION)).rejects.toBeInstanceOf(
        SvTransportError
      )
    })
  })
})
