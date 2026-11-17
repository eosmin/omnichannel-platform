import { FiscalConsultState, FiscalEnvironment, FiscalSubmitOutcome } from '@platform/core/domain'
import type { BuiltDocument, ProviderContext } from '@platform/fiscal/sdk'

import { SvCredentialKeys, SvProviderDataKeys, SvRejectionReasons } from './sv-constants'
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

  const make = (over: { receptionTimeoutMs?: number } = {}): SvProvider =>
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
})
