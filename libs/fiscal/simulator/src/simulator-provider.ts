import { FiscalConsultState, FiscalEnvironment, FiscalSubmitOutcome } from '@platform/core/domain'
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
  REJECT_REASON: 'simulated_rejection',
  VOID_REFUSED_REASON: 'simulated_void_refused'
} as const

const FAKE_KEY = 'simulator-key-not-a-secret'

// No state: every answer is a function of the receiver and of the key and the attempt of the call, so a worker that restarts, or another
// process, answers what the first one would have. The authority "received" a LOST document on its first attempt and knows it from then on.
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

  validateIssuer(
    issuer: FiscalIssuerInput,
    credentials: FiscalIssuerCredentials
  ): Promise<IssuerCheck> {
    const problems: string[] = []
    if (issuer.legalName.trim() === '') problems.push('legalName')
    if (issuer.taxId.trim() === '') problems.push('taxId')
    if (Object.keys(issuer.address).length === 0) problems.push('address')
    const key = credentials.credentials['signingKey']
    if (typeof key !== 'string' || key.trim() === '') problems.push('signingKey')
    if (issuer.environment !== FiscalEnvironment.SANDBOX) problems.push('environment')
    return Promise.resolve({ ok: problems.length === 0, problems })
  }

  build(input: FiscalBuildInput): Promise<BuiltDocument> {
    const business = input.receiver.taxId !== null && input.receiver.taxId.trim() !== ''
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
      shippingTaxCents: input.shippingTaxCents,
      discountCents: input.discountCents,
      totalCents: input.totalCents,
      taxCents: input.taxCents,
      // A fake signature: a hash of nothing a real authority would accept
      signature: `${FAKE_KEY}:${input.sequenceNumber}`
    }
    return Promise.resolve({ documentType, payload, missingReceiverFields: missing })
  }

  submit(built: BuiltDocument, ctx: ProviderContext): Promise<SubmitResult> {
    const taxId = this.taxIdOf(built)
    if (taxId === SimulatorRules.REJECT) {
      return Promise.resolve({
        outcome: FiscalSubmitOutcome.REJECTED,
        reason: SimulatorRules.REJECT_REASON,
        response: { accepted: false }
      })
    }
    // Down for the first N attempts of the submission, then answering
    if (taxId.startsWith(SimulatorRules.UNAVAILABLE) && ctx.attempt <= this.unavailableFor(taxId)) {
      return Promise.resolve({ outcome: FiscalSubmitOutcome.UNAVAILABLE })
    }
    // LOST: the authority has it from the first attempt, and its answer never arrived
    if (taxId === SimulatorRules.LOST && ctx.attempt === 1) {
      return Promise.resolve({ outcome: FiscalSubmitOutcome.UNAVAILABLE })
    }
    return Promise.resolve(this.accepted(this.numberOf(ctx)))
  }

  consult(built: BuiltDocument, ctx: ProviderContext): Promise<ConsultResult> {
    // Only a LOST document is at the authority without an answer; any other was never received or was answered
    if (this.taxIdOf(built) !== SimulatorRules.LOST || ctx.attempt === 1) {
      return Promise.resolve({ state: FiscalConsultState.UNKNOWN })
    }
    const externalNumber = this.numberOf(ctx)
    return Promise.resolve({
      state: FiscalConsultState.ACCEPTED,
      externalNumber,
      providerData: { seal: `sim-seal-${externalNumber}` },
      response: { accepted: true }
    })
  }

  void(doc: StoredFiscalDocument, reason: string): Promise<VoidResult> {
    // Refused without a reason or for a document that never had a number from the authority
    if (reason.trim() === '' || doc.externalNumber === null) {
      return Promise.resolve({ voided: false, reason: SimulatorRules.VOID_REFUSED_REASON })
    }
    return Promise.resolve({ voided: true, response: { voided: true } })
  }

  private numberOf(ctx: ProviderContext): string {
    // The whole key: two submissions never share a number
    return `SIM-${ctx.idempotencyKey}`
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
