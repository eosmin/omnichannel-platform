import { FiscalEnvironment, FiscalSubmitOutcome } from '@platform/core/domain'
import type {
  BuiltDocument,
  ConsultResult,
  FiscalBuildInput,
  FiscalDocumentProvider,
  FiscalIssuerCredentials,
  FiscalIssuerInput,
  FiscalReceiverField,
  IssuerCheck,
  ProviderContext,
  StoredFiscalDocument,
  SubmitResult,
  VoidResult
} from '@platform/fiscal/sdk'

// The simulator (TDD_18 §8.1): a provider that builds a plausible document, "signs" it with a fake key and answers by rules the tests
// choose. It never talks to an authority and is registered in development and test only. The rules are in the receiver's tax id, so a
// spec or a person in development picks the answer without a switch in core:
//   REJECT          the authority refuses the document
//   UNAVAILABLE     the authority is down on the first attempt (UNAVAILABLE-2: on the first two), then answers
//   LOST            the submission is received but the answer is lost: the next consult finds it accepted
export const SIMULATOR_PROVIDER_ID = 'simulator'
export const SimulatorDocumentTypes = {
  CONSUMER: 'simulated_consumer',
  BUSINESS: 'simulated_business',
  CREDIT_NOTE: 'simulated_credit_note'
} as const
export const SimulatorRules = {
  REJECT: 'REJECT',
  UNAVAILABLE: 'UNAVAILABLE',
  LOST: 'LOST',
  REJECT_REASON: 'simulated_rejection'
} as const

const FAKE_KEY = 'simulator-key-not-a-secret'

// What the simulator "received", by idempotency key: a repeated key answers the first answer
interface Received {
  externalNumber: string
  voided: boolean
}

export class SimulatorProvider implements FiscalDocumentProvider {
  readonly id = SIMULATOR_PROVIDER_ID
  readonly countryCode = 'XX'
  readonly manifest = {
    documentTypes: [
      {
        id: SimulatorDocumentTypes.CONSUMER,
        label: 'Simulated consumer document',
        requiredReceiverFields: []
      },
      {
        id: SimulatorDocumentTypes.BUSINESS,
        label: 'Simulated business document',
        requiredReceiverFields: ['name', 'taxId'] as readonly FiscalReceiverField[]
      },
      {
        id: SimulatorDocumentTypes.CREDIT_NOTE,
        label: 'Simulated credit note',
        requiredReceiverFields: [],
        creditNote: true
      }
    ],
    requiredIssuerFields: ['legalName', 'taxId', 'address'],
    credentialKeys: ['signingKey'],
    environments: [FiscalEnvironment.SANDBOX]
  } as const
  readonly contingency = {
    description: 'The simulator keeps the document queued and answers on a later attempt.'
  }

  private readonly received = new Map<string, Received>()
  private readonly unavailableLeft = new Map<string, number>()

  validateIssuer(
    issuer: FiscalIssuerInput,
    credentials: FiscalIssuerCredentials
  ): Promise<IssuerCheck> {
    const problems: string[] = []
    if (issuer.legalName.trim() === '') problems.push('legalName')
    if (issuer.taxId.trim() === '') problems.push('taxId')
    if (Object.keys(issuer.address).length === 0) problems.push('address')
    if (typeof credentials.credentials['signingKey'] !== 'string') problems.push('signingKey')
    if (issuer.environment !== FiscalEnvironment.SANDBOX) problems.push('environment')
    return Promise.resolve({ ok: problems.length === 0, problems })
  }

  build(input: FiscalBuildInput): Promise<BuiltDocument> {
    const business = input.receiver.taxId !== null && input.receiver.taxId !== ''
    const documentType = business
      ? SimulatorDocumentTypes.BUSINESS
      : SimulatorDocumentTypes.CONSUMER
    const missing: FiscalReceiverField[] = []
    if (business && (input.receiver.name === null || input.receiver.name.trim() === '')) {
      missing.push('name')
    }
    const payload = {
      type: documentType,
      number: input.sequenceNumber,
      issuedAt: input.issuedAt,
      orderNumber: input.orderNumber,
      currency: input.currency,
      issuer: { legalName: input.issuer.legalName, taxId: input.issuer.taxId },
      receiver: { name: input.receiver.name, taxId: input.receiver.taxId },
      lines: input.lines.map(line => ({ ...line })),
      shippingCents: input.shippingCents,
      totalCents: input.totalCents,
      taxCents: input.taxCents,
      // A fake signature: a hash of nothing a real authority would accept
      signature: `${FAKE_KEY}:${input.sequenceNumber}`
    }
    return Promise.resolve({ documentType, payload, missingReceiverFields: missing })
  }

  submit(built: BuiltDocument, ctx: ProviderContext): Promise<SubmitResult> {
    const known = this.received.get(ctx.idempotencyKey)
    if (known !== undefined) return Promise.resolve(this.accepted(known.externalNumber))
    const taxId = this.taxIdOf(built)
    if (taxId === SimulatorRules.REJECT) {
      return Promise.resolve({
        outcome: FiscalSubmitOutcome.REJECTED,
        reason: SimulatorRules.REJECT_REASON,
        response: { accepted: false }
      })
    }
    if (taxId.startsWith(SimulatorRules.UNAVAILABLE)) {
      const left = this.unavailableLeft.get(ctx.idempotencyKey) ?? this.unavailableFor(taxId)
      if (left > 0) {
        this.unavailableLeft.set(ctx.idempotencyKey, left - 1)
        return Promise.resolve({ outcome: FiscalSubmitOutcome.UNAVAILABLE })
      }
    }
    const externalNumber = `SIM-${ctx.idempotencyKey.slice(-12)}`
    this.received.set(ctx.idempotencyKey, { externalNumber, voided: false })
    // LOST: the authority has it, the answer never arrived
    if (taxId === SimulatorRules.LOST)
      return Promise.resolve({ outcome: FiscalSubmitOutcome.UNAVAILABLE })
    return Promise.resolve(this.accepted(externalNumber))
  }

  consult(_built: BuiltDocument, ctx: ProviderContext): Promise<ConsultResult> {
    const known = this.received.get(ctx.idempotencyKey)
    if (known === undefined) return Promise.resolve({ state: 'unknown' })
    return Promise.resolve({
      state: 'accepted',
      externalNumber: known.externalNumber,
      providerData: { seal: `sim-seal-${known.externalNumber}` },
      response: { accepted: true }
    })
  }

  void(doc: StoredFiscalDocument, reason: string, ctx: ProviderContext): Promise<VoidResult> {
    const known = this.received.get(ctx.idempotencyKey)
    if (known !== undefined) known.voided = true
    if (reason.trim() === '' || doc.externalNumber === null) {
      return Promise.resolve({ voided: false, reason: 'simulated_void_refused' })
    }
    return Promise.resolve({ voided: true, response: { voided: true } })
  }

  private accepted(externalNumber: string): SubmitResult {
    return {
      outcome: FiscalSubmitOutcome.ACCEPTED,
      externalNumber,
      providerData: { seal: `sim-seal-${externalNumber}` },
      response: { accepted: true }
    }
  }

  private taxIdOf(built: BuiltDocument): string {
    const receiver = built.payload['receiver']
    if (typeof receiver === 'object' && receiver !== null && 'taxId' in receiver) {
      const taxId = receiver.taxId
      return typeof taxId === 'string' ? taxId : ''
    }
    return ''
  }

  private unavailableFor(taxId: string): number {
    const count = Number(taxId.split('-')[1])
    return Number.isInteger(count) && count > 0 ? count : 1
  }
}

export const simulatorProvider = (): SimulatorProvider => new SimulatorProvider()
