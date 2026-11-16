import { FiscalDocumentKind, FiscalEnvironment, FiscalSubmitOutcome } from '@platform/core/domain'
import type {
  FiscalBuildInput,
  FiscalDocumentProvider,
  FiscalIssuerInput,
  ProviderContext,
  SubmitResult
} from '@platform/fiscal/sdk'

// The contract every provider of fiscal documents passes (TDD_18 §8.1): the simulator today, the real provider of a country when the
// owner and the accountant bring its credentials. A provider that passes it can replace another with no change outside its package.
// What a given provider answers for a receiver is its own business, so the triggers (a receiver that makes it refuse, one that makes
// the authority unavailable, one whose answer is lost) are given by whoever runs the suite.
export interface FiscalContractFixtures {
  issuer: FiscalIssuerInput
  credentials: Record<string, unknown>
  // Strings that must never appear in anything a provider returns (a credential value, a key)
  secrets: readonly string[]
  // Receivers: `plain` is accepted; the others are optional
  receivers: {
    plain: { name: string | null; taxId: string | null }
    // What a sandbox of the provider answers by: a receiver it refuses, one whose authority is down on the first attempt, one whose answer
    // is lost after the document was received, and one that lacks what the type of its document needs. A provider with no way to
    // provoke one of them has not shown that it handles it, so none is optional.
    refused: { name: string | null; taxId: string | null }
    unavailable: { name: string | null; taxId: string | null }
    lostAnswer: { name: string | null; taxId: string | null }
    incomplete: { name: string | null; taxId: string | null }
  }
}

const baseInput = (
  fixtures: FiscalContractFixtures,
  receiver: { name: string | null; taxId: string | null },
  sequenceNumber: number
): FiscalBuildInput => ({
  kind: FiscalDocumentKind.SALE,
  credited: null,
  sequenceNumber,
  issuedAt: '2026-11-16T12:00:00.000Z',
  orderNumber: `ORD-${sequenceNumber}`,
  currency: 'USD',
  issuer: fixtures.issuer,
  receiver: { registrationId: null, address: null, email: null, phone: null, ...receiver },
  lines: [
    {
      description: 'Shirt (M)',
      quantity: 2,
      unitPriceCents: 1130,
      taxRateBps: 1300,
      taxCents: 260,
      totalCents: 2260
    }
  ],
  shippingCents: 565,
  shippingTaxCents: 65,
  discountCents: 0,
  totalCents: 2825,
  taxCents: 325
})

export function testFiscalProviderContract(
  makeProvider: () => FiscalDocumentProvider,
  fixtures: FiscalContractFixtures
): void {
  const contextOf = (key: string, attempt = 1): ProviderContext => ({
    issuer: fixtures.issuer,
    credentials: fixtures.credentials,
    idempotencyKey: key,
    attempt
  })
  // The answer of an accepted submission, or a failure that says what came instead
  const acceptedOf = (result: SubmitResult) => {
    if (result.outcome !== FiscalSubmitOutcome.ACCEPTED) {
      throw new Error(`expected an accepted answer, got ${result.outcome}`)
    }
    return result
  }
  const noSecrets = (value: unknown): void => {
    const text = JSON.stringify(value)
    for (const secret of fixtures.secrets) expect(text).not.toContain(secret)
  }

  describe('the manifest', () => {
    it('declares its own id, country, document types, issuer fields and credential names', () => {
      const provider = makeProvider()
      expect(provider.id).not.toBe('')
      expect(provider.countryCode).not.toBe('')
      expect(provider.manifest.documentTypes.length).toBeGreaterThan(0)
      expect(provider.manifest.environments.length).toBeGreaterThan(0)
      for (const environment of provider.manifest.environments) {
        expect(Object.values(FiscalEnvironment)).toContain(environment)
      }
      // The names of the credentials are declared, never their values
      for (const secret of fixtures.secrets) {
        expect(JSON.stringify(provider.manifest)).not.toContain(secret)
      }
    })
  })

  describe('the issuer', () => {
    it('accepts a complete issuer and names what is missing without echoing a value', async () => {
      const provider = makeProvider()
      const ok = await provider.validateIssuer(fixtures.issuer, {
        credentials: fixtures.credentials
      })
      expect(ok).toEqual({ ok: true, problems: [] })
      const empty = await provider.validateIssuer(
        { ...fixtures.issuer, legalName: '', taxId: '' },
        { credentials: {} }
      )
      expect(empty.ok).toBe(false)
      expect(empty.problems.length).toBeGreaterThan(0)
      noSecrets(empty)
    })
  })

  describe('building', () => {
    it('is pure: the same input builds the same document, of a type the manifest declares', async () => {
      const provider = makeProvider()
      const input = baseInput(fixtures, fixtures.receivers.plain, 1)
      const first = await provider.build(input)
      const second = await provider.build(input)
      expect(second).toEqual(first)
      expect(provider.manifest.documentTypes.map(type => type.id)).toContain(first.documentType)
      expect(first.missingReceiverFields).toEqual([])
      noSecrets(first)
    })

    it('builds the credit note of a sale with a type its manifest marks as a credit note, and names the document it cancels', async () => {
      const provider = makeProvider()
      const note = await provider.build({
        ...baseInput(fixtures, fixtures.receivers.plain, 7),
        kind: FiscalDocumentKind.CREDIT_NOTE,
        credited: {
          documentType: 'any',
          externalNumber: 'EXT-1',
          issuedAt: '2026-11-15T12:00:00.000Z',
          providerData: null
        }
      })
      const declared = provider.manifest.documentTypes.find(type => type.id === note.documentType)
      expect(declared?.creditNote).toBe(true)
      expect(JSON.stringify(note.payload)).toContain('EXT-1')
      noSecrets(note)
      // The document of a sale is never a credit note
      const sale = await provider.build(baseInput(fixtures, fixtures.receivers.plain, 8))
      expect(
        provider.manifest.documentTypes.find(type => type.id === sale.documentType)?.creditNote
      ).not.toBe(true)
    })

    it('says what the receiver lacks instead of building a document that would be refused', async () => {
      const built = await makeProvider().build(
        baseInput(fixtures, fixtures.receivers.incomplete, 2)
      )
      expect(built.missingReceiverFields.length).toBeGreaterThan(0)
    })
  })

  describe('submitting', () => {
    it('accepts, keeps the answer in the shape of core, and a repeated key never makes a second document', async () => {
      const provider = makeProvider()
      const built = await provider.build(baseInput(fixtures, fixtures.receivers.plain, 3))
      const first = await provider.submit(built, contextOf('contract-accept'))
      expect(first.outcome).toBe(FiscalSubmitOutcome.ACCEPTED)
      const again = await provider.submit(built, contextOf('contract-accept', 2))
      expect(again.outcome).toBe(FiscalSubmitOutcome.ACCEPTED)
      // The type says an accepted answer has its number; the repeated key gives the same one
      expect(acceptedOf(again).externalNumber).toBe(acceptedOf(first).externalNumber)
      expect(acceptedOf(again).providerData).toEqual(acceptedOf(first).providerData)
      noSecrets(first)
    })

    it('refuses with a code that is not customer data', async () => {
      const provider = makeProvider()
      const built = await provider.build(baseInput(fixtures, fixtures.receivers.refused, 4))
      const result = await provider.submit(built, contextOf('contract-refuse'))
      expect(result.outcome).toBe(FiscalSubmitOutcome.REJECTED)
      if (result.outcome !== FiscalSubmitOutcome.REJECTED) return
      expect(result.reason).not.toContain(fixtures.receivers.refused.taxId ?? '\0')
      noSecrets(result)
    })

    it('answers UNAVAILABLE while the authority is down and accepts when it is back', async () => {
      const provider = makeProvider()
      const built = await provider.build(baseInput(fixtures, fixtures.receivers.unavailable, 5))
      const down = await provider.submit(built, contextOf('contract-down'))
      expect(down.outcome).toBe(FiscalSubmitOutcome.UNAVAILABLE)
      const back = await provider.submit(built, contextOf('contract-down', 2))
      expect(back.outcome).toBe(FiscalSubmitOutcome.ACCEPTED)
    })

    it('finds by consulting what it received when its answer was lost, and knows nothing it never got', async () => {
      const provider = makeProvider()
      const unknown = await provider.consult(
        await provider.build(baseInput(fixtures, fixtures.receivers.plain, 6)),
        contextOf('contract-never-sent')
      )
      expect(unknown.state).toBe('unknown')
      const built = await provider.build(baseInput(fixtures, fixtures.receivers.lostAnswer, 7))
      const lost = await provider.submit(built, contextOf('contract-lost'))
      expect(lost.outcome).toBe(FiscalSubmitOutcome.UNAVAILABLE)
      const found = await provider.consult(built, contextOf('contract-lost', 2))
      expect(found.state).toBe('accepted')
    })
  })

  describe('voiding', () => {
    it('voids an accepted document for a reason and refuses an empty reason', async () => {
      const provider = makeProvider()
      const built = await provider.build(baseInput(fixtures, fixtures.receivers.plain, 8))
      const accepted = await provider.submit(built, contextOf('contract-void'))
      const stored = {
        documentType: built.documentType,
        externalNumber: acceptedOf(accepted).externalNumber,
        providerData: acceptedOf(accepted).providerData ?? null,
        payload: built.payload
      }
      expect((await provider.void(stored, '', contextOf('contract-void-op'))).voided).toBe(false)
      const voided = await provider.void(stored, 'wrong customer', contextOf('contract-void-op'))
      expect(voided.voided).toBe(true)
      noSecrets(voided)
    })
  })
}
