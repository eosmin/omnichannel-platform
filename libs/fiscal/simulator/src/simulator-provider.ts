import {
  FiscalConsultState,
  FiscalDocumentKind,
  FiscalEnvironment,
  FiscalLimits,
  FiscalSubmitOutcome,
  FiscalVoidConsultState,
  PurchaseDocumentProblems
} from '@platform/core/domain'
import type {
  BuiltDocument,
  FiscalPurchaseDocumentInput,
  ConsultResult,
  FiscalBuildInput,
  FiscalDocumentProvider,
  FiscalIssuerCredentials,
  FiscalIssuerInput,
  FiscalReceiver,
  FiscalReceiverField,
  FiscalReceiverProblem,
  FiscalTypeInput,
  IssuerCheck,
  ProviderContext,
  StoredFiscalDocument,
  SubmitResult,
  VoidConsultResult,
  VoidResult
} from '@platform/fiscal/sdk'

// The simulator (TDD_18 §8.1): a provider that builds a plausible document, "signs" it with a fake key and answers by rules the tests
// choose. It never talks to an authority and is registered in development and test only. The rules are in the receiver's tax id, so a
// spec or a person in development picks the answer without a switch in core:
//   REJECT          the authority refuses the document
//   UNAVAILABLE     the authority is down on the first attempt (UNAVAILABLE-2: on the first two), then answers
//   LOST            the submission is received but the answer is lost: the next consult finds it accepted
//   VOID_LOST       the invalidation is received but the answer is lost (the call fails): asked again, the authority has it voided
export const SIMULATOR_PROVIDER_ID = 'simulator'
export const SimulatorDocumentTypes = {
  CONSUMER: 'simulated_consumer',
  BUSINESS: 'simulated_business',
  CREDIT_NOTE: 'simulated_credit_note',
  DEBIT_NOTE: 'simulated_debit_note',
  REMISSION_NOTE: 'simulated_remission_note',
  PURCHASE: 'simulated_purchase'
} as const
export const SimulatorRules = {
  REJECT: 'REJECT',
  // The one class of purchase document the simulator refuses, so a test reaches the rule of a provider on it
  INVALID_PURCHASE_CLASS: '9',
  UNAVAILABLE: 'UNAVAILABLE',
  LOST: 'LOST',
  VOID_LOST: 'VOID_LOST',
  REJECT_REASON: 'simulated_rejection',
  VOID_REFUSED_REASON: 'simulated_void_refused',
  TAX_ID_WITH_SPACES: 'simulated_tax_id_has_spaces'
} as const

const FAKE_KEY = 'simulator-key-not-a-secret'

// No state: every answer is a function of the receiver and of the key and the attempt of the call, so a worker that restarts, or another
// process, answers what the first one would have. The authority "received" a LOST document on its first attempt and knows it from then on.
// How long after it is asked the simulator says a document may still be invalidated
export const SimulatorVoidWindowMs = 4 * 24 * 60 * 60 * 1000

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
      },
      {
        id: SimulatorDocumentTypes.DEBIT_NOTE,
        label: 'Simulated debit note',
        requiredReceiverFields: [],
        debitNote: true
      },
      {
        id: SimulatorDocumentTypes.REMISSION_NOTE,
        label: 'Simulated remission note',
        requiredReceiverFields: [],
        remissionNote: true
      },
      {
        id: SimulatorDocumentTypes.PURCHASE,
        label: 'Simulated purchase document',
        requiredReceiverFields: [],
        purchase: true
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

  // The simulator's only rule: a tax id has no spaces (what a real provider checks is its country's format)
  validateReceiver(receiver: FiscalReceiver): readonly FiscalReceiverProblem[] {
    return receiver.taxId !== null && /\s/.test(receiver.taxId)
      ? [{ field: 'taxId', code: SimulatorRules.TAX_ID_WITH_SPACES }]
      : []
  }

  // The supplier's document of a purchase: the simulator refuses only the class it names, so the wiring to the provider can be tested
  validatePurchaseDocument(input: FiscalPurchaseDocumentInput): readonly string[] {
    return input.documentClass === SimulatorRules.INVALID_PURCHASE_CLASS
      ? [PurchaseDocumentProblems.CLASS_INVALID]
      : []
  }

  // The same rule for a party that is not a receiver (a supplier): no spaces
  validatePartyTaxId(taxId: string): boolean {
    return !/\s/.test(taxId)
  }

  // The type of a sale, a credit note or a debit note: a credit note or a debit note, a business when the receiver has a tax id, a consumer otherwise. The simulator
  // numbers by the correlative of the organization (it declares no series), so core never asks it; it answers like `build` for the contract suite.
  resolveDocumentType(input: FiscalTypeInput): string {
    if (input.kind === FiscalDocumentKind.CREDIT_NOTE) return SimulatorDocumentTypes.CREDIT_NOTE
    if (input.kind === FiscalDocumentKind.DEBIT_NOTE) return SimulatorDocumentTypes.DEBIT_NOTE
    if (input.kind === FiscalDocumentKind.REMISSION_NOTE)
      return SimulatorDocumentTypes.REMISSION_NOTE
    if (input.kind === FiscalDocumentKind.PURCHASE) return SimulatorDocumentTypes.PURCHASE
    const business = input.receiver.taxId !== null && input.receiver.taxId.trim() !== ''
    return business ? SimulatorDocumentTypes.BUSINESS : SimulatorDocumentTypes.CONSUMER
  }

  build(input: FiscalBuildInput): Promise<BuiltDocument> {
    const business = input.receiver.taxId !== null && input.receiver.taxId.trim() !== ''
    const documentType = this.resolveDocumentType(input)
    const missing: FiscalReceiverField[] = []
    if (business && (input.receiver.name === null || input.receiver.name.trim() === '')) {
      missing.push('name')
    }
    const payload = {
      type: documentType,
      number: input.correlative,
      documentUuid: input.documentUuid,
      issuedAt: input.issuedAt,
      orderNumber: input.orderNumber,
      // A credit note or a debit note names the document it changes; a sale names none
      credits:
        input.credited === null
          ? null
          : {
              type: input.credited.documentType,
              number: input.credited.externalNumber,
              issuedAt: input.credited.issuedAt
            },
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
    if (this.unavailableFor(taxId) >= ctx.attempt) {
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

  // Stateless like the rest: a VOID_LOST document was invalidated by its first attempt (its answer never arrived), so it is voided for any
  // consultation after it (attempt 2); before the first attempt it is not
  consultVoid(doc: StoredFiscalDocument, ctx: ProviderContext): Promise<VoidConsultResult> {
    if (this.taxIdOfStored(doc) === SimulatorRules.VOID_LOST && ctx.attempt >= 2) {
      return Promise.resolve({
        state: FiscalVoidConsultState.VOIDED,
        response: { voided: true, recovered: true }
      })
    }
    return Promise.resolve({ state: FiscalVoidConsultState.NOT_VOIDED })
  }

  // The simulator keeps no seal day, so its window is counted from the moment it is asked: four days ahead, like the window of a remission note
  // of the first real provider. It exists so the notice of the last day to void a document can be exercised end to end.
  voidDeadline(): string | null {
    return new Date(Date.now() + SimulatorVoidWindowMs).toISOString()
  }

  void(doc: StoredFiscalDocument, reason: string): Promise<VoidResult> {
    // The answer of the authority is lost: the call fails, the invalidation was received
    if (this.taxIdOfStored(doc) === SimulatorRules.VOID_LOST) {
      return Promise.reject(new Error('simulated void timeout'))
    }
    // Refused without a reason or for a document that never had a number from the authority
    if (reason.trim() === '' || doc.externalNumber === null) {
      return Promise.resolve({
        voided: false,
        reason: SimulatorRules.VOID_REFUSED_REASON,
        byAuthority: true
      })
    }
    // The event it "signed": what the lifecycle seals and keeps for the delivery of the invalidation (nothing a real authority would read)
    return Promise.resolve({
      voided: true,
      response: { voided: true },
      event: {
        content: { simulated: true, externalNumber: doc.externalNumber },
        signature: `sim-signature-${doc.externalNumber}`
      }
    })
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

  private taxIdOfStored(doc: StoredFiscalDocument): string {
    return this.taxIdOf({ payload: doc.payload })
  }

  private taxIdOf(built: { payload: Readonly<Record<string, unknown>> }): string {
    const receiver = built.payload['receiver']
    if (typeof receiver === 'object' && receiver !== null && 'taxId' in receiver) {
      const taxId = receiver.taxId
      return typeof taxId === 'string' ? taxId : ''
    }
    return ''
  }

  // How many attempts the authority is down for: UNAVAILABLE is 1, UNAVAILABLE-3 is 3 (at most one less than the attempts of the queue,
  // so the document is always answered in the end); any other tax id is never unavailable
  private unavailableFor(taxId: string): number {
    const found = /^UNAVAILABLE(?:-(\d{1,2}))?$/.exec(taxId)
    if (found === null) return 0
    const count = found[1] === undefined ? 1 : Number(found[1])
    return Math.min(Math.max(count, 1), FiscalLimits.MAX_ATTEMPTS - 1)
  }
}

export const simulatorProvider = (): SimulatorProvider => new SimulatorProvider()
