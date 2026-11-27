import { createHash } from 'node:crypto'

import {
  FinancePostingKey,
  FiscalDocumentImmutableStatuses,
  FiscalDocumentKind,
  FiscalDocumentStatus,
  FiscalDocumentStatusTransitions,
  FiscalOperationCondition,
  FiscalRejectionDeadlineState,
  fiscalSubmitMaxAttempts,
  FiscalRejectionReasons,
  FiscalRejectionRetry,
  type FiscalEnvironment,
  maskReceiverName,
  maskReceiverTaxId,
  PaymentMethod,
  PaymentStatus,
  ShipmentStatus,
  TaxTreatment
} from '@platform/core/domain'
import { lineBases, reversalLinesOf } from '@platform/core/finance'
import type {
  FiscalLine,
  FiscalPayment,
  FiscalReceiver,
  FiscalSequenceDeclaration
} from '@platform/fiscal/sdk'

// The pure rules of the lifecycle of a fiscal document (TDD_18 §8.3): no database, no provider.

// The key of the entry of the books a document belongs to: the sale, or the return its credit note is for; none for a remission note, which
// is no sale and never carries an entry. The link is made by this key, never by copying amounts.
export function entryKeyOfDocument(doc: {
  kind: string
  orderId: string
  returnId: string | null
}): string | null {
  if (doc.kind === (FiscalDocumentKind.REMISSION_NOTE as string)) return null
  if (doc.kind !== (FiscalDocumentKind.CREDIT_NOTE as string)) {
    return FinancePostingKey.ORDER_SALE(doc.orderId)
  }
  return doc.returnId === null
    ? FinancePostingKey.ORDER_RETURN(doc.orderId)
    : FinancePostingKey.RETURN_RESTOCK(doc.returnId)
}

export const canTransition = (from: FiscalDocumentStatus, to: FiscalDocumentStatus): boolean =>
  FiscalDocumentStatusTransitions[from].includes(to)

export const isImmutable = (status: FiscalDocumentStatus): boolean =>
  FiscalDocumentImmutableStatuses.includes(status)

// A person may fix the receiver of a document that was refused or has never been sent. A document that went back to the queue after an
// attempt may already be at the authority (an answer that was lost): it stays as it was built until the provider has been asked about it.
export const receiverEditable = (status: FiscalDocumentStatus, attempts: number): boolean =>
  status === FiscalDocumentStatus.REJECTED ||
  (status === FiscalDocumentStatus.QUEUED && attempts === 0)

// Retried from a refusal, or from the queue when the job was lost (the attempts ran out while the authority was down)
export const retryable = (status: FiscalDocumentStatus): boolean =>
  status === FiscalDocumentStatus.REJECTED || status === FiscalDocumentStatus.QUEUED

// The window to correct and send again a document the authority refused, counted from the moment the refusal was communicated. A document
// that was not refused by the authority (`rejectedAt` null: refused by core before it was sent, or not refused) has no window. The clock is
// the caller's, so the same document reads the same at any instant that is given.
export interface FiscalRejectionDeadline {
  endsAt: Date
  state: FiscalRejectionDeadlineState
}

export function rejectionDeadline(
  rejectedAt: Date | null,
  now: Date
): FiscalRejectionDeadline | null {
  if (rejectedAt === null) return null
  const endsAt = new Date(rejectedAt.getTime() + FiscalRejectionRetry.WINDOW_MS)
  const left = endsAt.getTime() - now.getTime()
  const state =
    left <= 0
      ? FiscalRejectionDeadlineState.EXPIRED
      : left <= FiscalRejectionRetry.WARN_BEFORE_MS
        ? FiscalRejectionDeadlineState.CLOSING
        : FiscalRejectionDeadlineState.OPEN
  return { endsAt, state }
}

// A document that stays in the queue after every attempt of its job was spent: it needs a person (a retry), nothing will move it by itself
// (one kept in a contingency has the attempts of the whole window of its lot, so it is stuck later than an ordinary one)
export const isStuck = (
  status: FiscalDocumentStatus,
  attempts: number,
  inContingency = false
): boolean =>
  status === FiscalDocumentStatus.QUEUED && attempts >= fiscalSubmitMaxAttempts(inContingency)

// What the state of a document allows a person to do with it. The screen draws its buttons from this and the api decides again on every
// call (the rules of the calls are the ones in `FiscalDocumentsService`); the permission to do it is the route's, not this function's.
// It is a necessary condition, read from the document alone: a call can still be refused for something outside the document (credit notes
// that are alive against a sale that is voided, an issuer that moved since the document was refused, a note that was made again) and
// answers with the reason the screen has words for.
export interface FiscalDocumentActions {
  // The receiver of a sale document that was refused or never sent: a credit note's receiver is its sale document's
  readonly editReceiver: boolean
  // Sent again from a refusal, or from the queue when the job was lost
  readonly retry: boolean
  // The invalidation of an accepted document: irreversible
  readonly void: boolean
  // A voided sale document that nobody replaced, or a voided credit note (its replacement is the note of its return, which the view does not
  // name: the api refuses with `note_already_replaced`)
  readonly replace: boolean
  // A refused document that was sent at least once and whose refusal is that the issuer changed: the person says it is not at the old issuer
  readonly confirmIssuerChange: boolean
}

export function allowedActionsOf(document: {
  kind: FiscalDocumentKind
  status: FiscalDocumentStatus
  attempts: number
  rejectionReason: string | null
  replacedByDocumentId: string | null
}): FiscalDocumentActions {
  const sale = document.kind === FiscalDocumentKind.SALE
  // A remission note takes the receiver like a sale document (the goods need to say who they go to, and a person completes it). The one of a
  // voided note is made again for the same guide, as a credit note is (a new document, no link of replacement): the service refuses it with a
  // reason when the goods no longer travel or the guide has a live note
  const remission = document.kind === FiscalDocumentKind.REMISSION_NOTE
  const refused = document.status === FiscalDocumentStatus.REJECTED
  return {
    editReceiver: (sale || remission) && receiverEditable(document.status, document.attempts),
    retry: retryable(document.status),
    void: document.status === FiscalDocumentStatus.ACCEPTED,
    replace:
      document.status === FiscalDocumentStatus.VOIDED &&
      (sale ? document.replacedByDocumentId === null : true),
    confirmIssuerChange:
      refused &&
      document.attempts > 0 &&
      document.rejectionReason === FiscalRejectionReasons.ISSUER_CHANGED
  }
}

export interface OrderLineRow {
  productName: string
  variantName: string | null
  quantity: number
  unitPriceCents: number
  taxRateBps: number | null
  taxCents: number | null
  // The treatment snapshot of the order item: null on an order made before it
  taxTreatment: string | null
}

// The lines of the document from the lines of the order and the tax snapshot of Step 4B.3b: the amounts are the order's, never
// recomputed here. A line of an order that predates the tax snapshot (null) carries no tax. `totalCents` is the line before its share of
// the order's discount, which travels once, as `discountCents` of the whole document (`FiscalBuildInput`).
export function documentLines(rows: readonly OrderLineRow[]): FiscalLine[] {
  return rows.map(row => ({
    description:
      row.variantName === null || row.variantName.trim() === ''
        ? row.productName
        : `${row.productName} (${row.variantName.trim()})`,
    quantity: row.quantity,
    unitPriceCents: row.unitPriceCents,
    // A rate with no tax amount is a partial snapshot: the line says no rate rather than a rate with no tax
    taxRateBps: row.taxCents === null ? null : row.taxRateBps,
    taxCents: row.taxCents ?? 0,
    totalCents: row.quantity * row.unitPriceCents,
    taxTreatment: taxTreatmentOf(row.taxTreatment)
  }))
}

const TAX_TREATMENTS: readonly string[] = Object.values(TaxTreatment)

// The treatment the order kept, or null for none or for a value this version does not know: core never invents one
function taxTreatmentOf(value: string | null): TaxTreatment | null {
  return value !== null && TAX_TREATMENTS.includes(value) ? (value as TaxTreatment) : null
}

// How the order was paid, for the provider that says it in its document: one payment for the whole order, because that is what the order
// records. A reference of only blanks is none.
export function paymentsOf(
  method: PaymentMethod,
  reference: string | null,
  totalCents: number
): FiscalPayment[] {
  const kept = reference === null || reference.trim() === '' ? null : reference.trim()
  return [{ method, amountCents: totalCents, reference: kept }]
}

const PAYMENT_METHODS: readonly string[] = Object.values(PaymentMethod)

// How the order was paid as the document kept it in its snapshot (`paymentMethod`, `paymentReference`, `paymentStatus`): what the provider
// gets in `FiscalBuildInput`. A snapshot made before these were kept (or with a method this version does not know) says no payment and
// nothing was paid: the condition is deferred, never a claim that the sale was paid.
export function paymentOfSnapshot(
  parts: Readonly<Record<string, unknown>>,
  totalCents: number,
  // A credit note gives back part of a sale: what it gives back is not a payment of its own, so it carries none (the provider reads the
  // payment of the document it cancels). Its condition is the one of the order's payment status.
  isCreditNote = false
): { payments: FiscalPayment[]; condition: FiscalOperationCondition } {
  const method = parts['paymentMethod']
  const reference = parts['paymentReference']
  const status = parts['paymentStatus']
  return {
    payments:
      !isCreditNote && typeof method === 'string' && PAYMENT_METHODS.includes(method)
        ? paymentsOf(
            method as PaymentMethod,
            typeof reference === 'string' ? reference : null,
            totalCents
          )
        : [],
    condition: operationConditionOf(typeof status === 'string' ? status : '')
  }
}

// A payment that is completed was made at the sale; anything else (pending, failed, refunded, a status this version does not know) was not
export function operationConditionOf(paymentStatus: string): FiscalOperationCondition {
  return paymentStatus === (PaymentStatus.COMPLETED as string)
    ? FiscalOperationCondition.IMMEDIATE
    : FiscalOperationCondition.DEFERRED
}

export interface FiscalSequenceParts {
  providerId: string
  environment: FiscalEnvironment
  documentType: string
  establishmentCode: string | null
  pointOfSaleCode: string | null
}

// Whether the manifest asks for a series of its own: a scope with nothing declared is the correlative of the organization
export function declaresSequence(scope: FiscalSequenceDeclaration | undefined): boolean {
  return (
    scope?.perDocumentType === true ||
    scope?.perEstablishment === true ||
    scope?.perPointOfSale === true
  )
}

// The key of the series a document's correlative is counted in (see `FiscalSequenceDeclaration`), or null when the manifest declares no
// scope and the organization counts them all. One series per distinct provider, environment and declared parts: a sandbox number and a
// production one never meet, and neither do two providers. The parts go through a JSON array before they are hashed, so none of them can
// run into the next ("a|b" + "c" is not "a" + "b|c", and an empty code is not a missing one). A hash, because the type id of a provider has no
// length limit core could rely on and the key is a column.
export function fiscalSequenceKey(
  scope: FiscalSequenceDeclaration | undefined,
  parts: FiscalSequenceParts
): string | null {
  if (scope === undefined || !declaresSequence(scope)) return null
  const key = [
    parts.providerId,
    parts.environment,
    scope.perDocumentType === true ? parts.documentType : undefined,
    scope.perEstablishment === true ? parts.establishmentCode : undefined,
    scope.perPointOfSale === true ? parts.pointOfSaleCode : undefined
  ]
  // `undefined` becomes null in a JSON array, so the declared-but-empty and the not-declared would meet: the flags go in as well
  const flags = [
    scope.perDocumentType === true,
    scope.perEstablishment === true,
    scope.perPointOfSale === true
  ]
  return createHash('sha256')
    .update(JSON.stringify([key, flags]))
    .digest('hex')
}

// A stable identifier of a document in the shape of a random UUID version 4, derived from the organization and the document: the same
// every time it is asked, so every attempt and every submission of a document names it the same way
export function fiscalDocumentUuid(organizationId: string, documentId: string): string {
  const bytes = createHash('sha256')
    .update(JSON.stringify([organizationId, documentId]))
    .digest()
    .subarray(0, 16)
  // Version 4 and the variant of RFC 4122, like a random one
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = Buffer.from(bytes).toString('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20)
  ].join('-')
}

const RECEIVER_FIELDS = [
  'name',
  'taxId',
  'registrationId',
  'email',
  'phone',
  'taxpayerType',
  'economicActivity',
  'documentType'
] as const

// What is stored of the receiver, as a plain record of strings (customer data: it is encrypted before it is kept)
export function receiverRecord(receiver: FiscalReceiver): Record<string, unknown> {
  const record: Record<string, unknown> = {}
  for (const field of RECEIVER_FIELDS) {
    const value = receiver[field]
    if (value !== undefined && value !== null && value.trim() !== '') record[field] = value.trim()
  }
  const address = cleanAddress(receiver.address)
  if (address !== null) record['address'] = address
  return record
}

// The address as it is stored and as it is read: values trimmed, the empty ones gone, nothing left is no address
function cleanAddress(
  address: Readonly<Record<string, unknown>> | null
): Record<string, string> | null {
  if (address === null) return null
  const clean: Record<string, string> = {}
  for (const [key, value] of Object.entries(address)) {
    if (typeof value === 'string' && value.trim() !== '') clean[key] = value.trim()
  }
  return Object.keys(clean).length > 0 ? clean : null
}

// The sale as it was kept in the document at the moment it was made (the lines snapshot) with the amounts the document is for
export interface FiscalSale {
  lines: FiscalLine[]
  shippingCents: number
  shippingTaxCents: number
  discountCents: number
  pricesIncludeTax: boolean
  totalCents: number
  taxCents: number
}

const amount = (value: unknown): number =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : 0

export function saleOf(
  doc: { totalCents: number; taxCents: number },
  parts: Readonly<Record<string, unknown>>
): FiscalSale {
  return {
    // A snapshot made before the treatment was kept has no `taxTreatment` on its lines: it reads as none, never as a guess
    lines: Array.isArray(parts['lines'])
      ? (parts['lines'] as unknown[]).map(raw => {
          // What is not a line stays as it is: the detail reads a malformed snapshot as an empty line, never a crash
          if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
            return raw as FiscalLine
          const line = raw as FiscalLine
          return {
            ...line,
            taxTreatment: taxTreatmentOf(line.taxTreatment ?? null)
          }
        })
      : [],
    shippingCents: amount(parts['shippingCents']),
    shippingTaxCents: amount(parts['shippingTaxCents']),
    discountCents: amount(parts['discountCents']),
    pricesIncludeTax: parts['pricesIncludeTax'] !== false,
    totalCents: doc.totalCents,
    taxCents: doc.taxCents
  }
}

// What the order took must be what the document is for (the provider never sees an inconsistent sale): the tax of the lines and of the
// shipping is the tax of the order, and the lines less the discount plus the shipping (plus the tax when the prices did not include it)
// is its total. The amounts are the order's own; this only checks them against each other.
export function saleAddsUp(sale: FiscalSale): boolean {
  const linesTax = sale.lines.reduce((sum, line) => sum + line.taxCents, 0)
  if (linesTax + sale.shippingTaxCents !== sale.taxCents) return false
  const linesTotal = sale.lines.reduce((sum, line) => sum + line.totalCents, 0)
  const expected =
    linesTotal -
    sale.discountCents +
    sale.shippingCents +
    (sale.pricesIncludeTax ? 0 : sale.taxCents)
  return expected === sale.totalCents
}

// The tax of the shipping is part of the fee and never more than it, as the entry of the sale reads it (E3) and the VAT report too: the
// difference between the tax of the order and the tax of its lines is not the tax of a shipping that is not there. Asked when a SALE is
// built for the provider, not of the detail of a document that was already sent (that one keeps what it was sealed with) and not of a credit note.
export function shippingTaxFits(sale: FiscalSale): boolean {
  return sale.shippingTaxCents >= 0 && sale.shippingTaxCents <= sale.shippingCents
}

export interface CreditNoteOrder {
  subtotalCents: number
  discountCents: number
  shippingCents: number
  totalCents: number
  // Null on an order made before the tax columns: such an order has no credit note (what it reverses is not recorded)
  taxCents: number | null
  pricesIncludeTax: boolean | null
  lines: readonly (OrderLineRow & { orderItemId: string })[]
}

export type CreditNoteSale = { ok: true; sale: FiscalSale } | { ok: false }

// The credit note of the units of a return: the lines that came back, with the revenue and the tax the sale gave them, split the way the
// books split them when the return was received (`reversalLinesOf`: the running total of units back, so the parts of many returns add up to
// the sale to the cent). The shipping fee is not credited (nothing says it was given back: [ACCOUNTANT], TDD_18 §13). The discount is what
// the units had in gross, less what they brought in, so the document adds up like the one of a sale (`saleAddsUp`). A sale that does not
// add up, or more units back than were sold, is refused and never forced.
export function creditNoteSaleOf(
  order: CreditNoteOrder,
  before: ReadonlyMap<string, number>,
  returned: ReadonlyMap<string, number>
): CreditNoteSale {
  const bases = lineBases({
    subtotalCents: order.subtotalCents,
    shippingCents: order.shippingCents,
    discountCents: order.discountCents,
    totalCents: order.totalCents,
    taxCents: order.taxCents,
    pricesIncludeTax: order.pricesIncludeTax,
    lines: order.lines.map(line => ({
      orderItemId: line.orderItemId,
      quantity: line.quantity,
      unitPriceCents: line.unitPriceCents,
      taxCents: line.taxCents
    }))
  })
  if (!bases.ok) return { ok: false }
  const reversed = reversalLinesOf({ bases: bases.lines, before, returned })
  if (!reversed.ok || reversed.lines.length === 0) return { ok: false }
  const includesTax = order.pricesIncludeTax !== false
  const lines: FiscalLine[] = []
  let discountCents = 0
  let taxCents = 0
  let totalCents = 0
  for (const back of reversed.lines) {
    const row = order.lines.find(line => line.orderItemId === back.orderItemId)
    const described = row === undefined ? undefined : documentLines([row])[0]
    if (row === undefined || described === undefined) return { ok: false }
    const gross = back.quantity * row.unitPriceCents
    const rawBase = back.netCents + (includesTax ? back.vatCents : 0)
    // The books split the units back on what they were sold for (`reversalLinesOf`), so net and tax together are the gross of the units. Only
    // a line so small that its net and tax are each prorated on their own (a cent of net would otherwise come back negative) can pass the
    // gross by a cent: that cent is the rounding of the books, not a discount, and the line is credited for what the units were sold for.
    // More than a cent over is not a rounding and is refused.
    if (rawBase > gross + 1) return { ok: false }
    const base = Math.min(rawBase, gross)
    lines.push({
      ...described,
      quantity: back.quantity,
      taxCents: back.vatCents,
      totalCents: gross
    })
    discountCents += gross - base
    taxCents += back.vatCents
    totalCents += base + (includesTax ? 0 : back.vatCents)
  }
  return {
    ok: true,
    sale: {
      lines,
      shippingCents: 0,
      shippingTaxCents: 0,
      discountCents,
      pricesIncludeTax: includesTax,
      totalCents,
      taxCents
    }
  }
}

// Whether the sale document a credit note cancels (part of) is ready for it: only an accepted document can be credited; a voided one was
// never a sale (a person replaces it, and the credit note follows the replacement); any other state is the sale document still on its way
export type OriginalState = 'ready' | 'waiting' | 'voided'
export const originalStateOf = (status: FiscalDocumentStatus): OriginalState => {
  if (status === FiscalDocumentStatus.ACCEPTED) return 'ready'
  return status === FiscalDocumentStatus.VOIDED ? 'voided' : 'waiting'
}

const ISSUER_IDENTITY = [
  'legalName',
  'taxId',
  'registrationId',
  'activityCode',
  'establishmentCode',
  // The kind of establishment and the point of sale are part of the identity (they name the series a document is numbered in). The
  // contact (phone, email) is not: it is read from the snapshot the document keeps, so fixing a typo in it never refuses a document in flight.
  'establishmentType',
  'pointOfSaleCode',
  'environment'
] as const

// Whether the issuer as it is now is the one a document was made with: the same identity, the same environment, the same address. The
// provider is compared by the caller (it is a column of the document). A document is never signed in the name of another issuer.
export function sameIssuer(
  snapshot: Readonly<Record<string, unknown>>,
  live: {
    legalName: string
    taxId: string
    registrationId: string | null
    activityCode: string | null
    establishmentCode: string | null
    establishmentType: string | null
    pointOfSaleCode: string | null
    environment: string
    address: unknown
  }
): boolean {
  const same = (a: unknown, b: unknown): boolean => (a ?? null) === (b ?? null)
  return (
    ISSUER_IDENTITY.every(key => same(snapshot[key], live[key])) &&
    JSON.stringify(sorted(snapshot['address'])) === JSON.stringify(sorted(live.address))
  )
}

function sorted(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value ?? null
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
  )
}

export function receiverOf(record: Readonly<Record<string, unknown>>): FiscalReceiver {
  const text = (key: string): string | null => {
    const value = record[key]
    return typeof value === 'string' && value !== '' ? value : null
  }
  const address = record['address']
  return {
    name: text('name'),
    taxId: text('taxId'),
    registrationId: text('registrationId'),
    address:
      typeof address === 'object' && address !== null
        ? cleanAddress(address as Record<string, unknown>)
        : null,
    email: text('email'),
    phone: text('phone'),
    taxpayerType: text('taxpayerType'),
    economicActivity: text('economicActivity'),
    documentType: text('documentType')
  }
}

// The fiscal data of a customer over the contact data the sale already has: what the customer's fiscal record says wins over the order's
// own name and shipping address (a person who has a fiscal name and address is invoiced with them), and a field it leaves empty keeps what
// the sale had. The result is the receiver the document is made with, a copy that nothing later changes.
export function receiverWithFiscalData(
  sale: FiscalReceiver,
  fiscal: FiscalReceiver | null
): FiscalReceiver {
  if (fiscal === null) return sale
  return {
    name: fiscal.name ?? sale.name,
    taxId: fiscal.taxId ?? sale.taxId,
    registrationId: fiscal.registrationId ?? sale.registrationId,
    address: fiscal.address ?? sale.address,
    // The contact of the document stays the sale's: the fiscal record does not hold an email or a phone
    email: sale.email,
    phone: sale.phone,
    taxpayerType: fiscal.taxpayerType ?? sale.taxpayerType ?? null,
    economicActivity: fiscal.economicActivity ?? sale.economicActivity ?? null,
    documentType: fiscal.documentType ?? sale.documentType ?? null
  }
}

// The fiscal data of a customer as a person sees it: the identifiers masked (the last characters only), the address said to be set or not.
// The fiscal name, the kind of taxpayer and the activity are shown as they are: they are what a person needs to recognize the record, and
// the permission to view it (`fiscal:view_customer_data`) is what protects them. The mask shows how long an identifier is.
export interface MaskedCustomerFiscalData {
  name: string | null
  taxId: string | null
  registrationId: string | null
  taxpayerType: string | null
  economicActivity: string | null
  documentType: string | null
  addressSet: boolean
}

export function maskedCustomerFiscalData(receiver: FiscalReceiver): MaskedCustomerFiscalData {
  return {
    name: receiver.name,
    taxId: maskTaxId(receiver.taxId),
    registrationId: maskTaxId(receiver.registrationId),
    taxpayerType: receiver.taxpayerType ?? null,
    economicActivity: receiver.economicActivity ?? null,
    documentType: receiver.documentType ?? null,
    addressSet: receiver.address !== null
  }
}

// The tax id as the screens and the audit see it: the last characters only (a third of it at most), so a person can tell two receivers apart
export function maskTaxId(taxId: string | null): string | null {
  if (taxId === null) return null
  const id = taxId.trim()
  // A third of it at most, and never more than four characters: a short id shows almost nothing
  const shown = Math.min(4, Math.floor(id.length / 3))
  return `${'*'.repeat(id.length - shown)}${shown === 0 ? '' : id.slice(-shown)}`
}

// ---------------------------------------------------------------- the detail of a document (the sealed snapshot, read)

export interface FiscalDetailLine {
  description: string
  quantity: number
  unitPriceCents: number
  taxRateBps: number | null
  taxCents: number
  totalCents: number
}

// The lines of the document that carry the same rate: what the tax is charged on and the tax. A line with no rate is the group `null`.
export interface FiscalTaxGroup {
  taxRateBps: number | null
  baseCents: number
  taxCents: number
}

// The issuer as the document kept it when it was made: the identity and the address, never a credential (the snapshot has none)
export interface FiscalIssuerSnapshotView {
  legalName: string
  taxId: string
  registrationId: string | null
  address: Record<string, string>
  activityCode: string | null
  establishmentCode: string | null
  environment: string
}

export interface FiscalDocumentDetail {
  orderNumber: string
  pricesIncludeTax: boolean
  lines: FiscalDetailLine[]
  shippingCents: number
  shippingTaxCents: number
  discountCents: number
  // The bases are the lines before the discount (the discount travels once, for the whole document, as in the sealed sale); the tax of the
  // shipping is `shippingTaxCents`, in no group
  taxBreakdown: FiscalTaxGroup[]
  // Whether the sealed parts add up to the totals of the document (`saleAddsUp`): false is a snapshot that is damaged or predates the tax
  // snapshot, and the screen must say so instead of showing its numbers as sound
  consistent: boolean
  issuer: FiscalIssuerSnapshotView
}

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '')
const textOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null
const plainRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

// Reads the snapshots a document keeps (JSON, written by this service but read back as unknown) into a view with an allowlist of fields:
// each field is copied by name and checked by type, so nothing else that a snapshot may hold (a provider's data, a future field) reaches
// the interface. The tax is grouped by rate from the lines as they were sealed; the discount and the shipping are shown apart because
// their tax is not split by rate in the sealed sale.
export function documentDetailOf(
  doc: { totalCents: number; taxCents: number },
  linesSnapshot: unknown,
  issuerSnapshot: unknown
): FiscalDocumentDetail {
  const parts = plainRecord(linesSnapshot)
  const sale = saleOf(doc, parts)
  const lines: FiscalDetailLine[] = sale.lines.map(raw => {
    const line = plainRecord(raw)
    const rate = line['taxRateBps']
    return {
      description: textOf(line['description']),
      quantity: amount(line['quantity']),
      unitPriceCents: amount(line['unitPriceCents']),
      taxRateBps: typeof rate === 'number' && Number.isSafeInteger(rate) ? rate : null,
      taxCents: amount(line['taxCents']),
      totalCents: amount(line['totalCents'])
    }
  })
  const groups = new Map<number | null, FiscalTaxGroup>()
  for (const line of lines) {
    const group = groups.get(line.taxRateBps) ?? {
      taxRateBps: line.taxRateBps,
      baseCents: 0,
      taxCents: 0
    }
    group.taxCents += line.taxCents
    group.baseCents += sale.pricesIncludeTax ? line.totalCents - line.taxCents : line.totalCents
    groups.set(line.taxRateBps, group)
  }
  const issuer = plainRecord(issuerSnapshot)
  const address: Record<string, string> = {}
  for (const [key, value] of Object.entries(plainRecord(issuer['address']))) {
    if (typeof value === 'string' && value !== '') address[key] = value
  }
  return {
    orderNumber: textOf(parts['orderNumber']),
    pricesIncludeTax: sale.pricesIncludeTax,
    lines,
    shippingCents: sale.shippingCents,
    shippingTaxCents: sale.shippingTaxCents,
    discountCents: sale.discountCents,
    // The treatment does not take part in the sum of the amounts: the check reads the amounts of the lines as they were sealed
    consistent: saleAddsUp({
      ...sale,
      lines: lines.map(line => ({ ...line, taxTreatment: null }))
    }),
    taxBreakdown: [...groups.values()].sort((a, b) => (a.taxRateBps ?? -1) - (b.taxRateBps ?? -1)),
    issuer: {
      legalName: textOf(issuer['legalName']),
      taxId: textOf(issuer['taxId']),
      registrationId: textOrNull(issuer['registrationId']),
      address,
      activityCode: textOrNull(issuer['activityCode']),
      establishmentCode: textOrNull(issuer['establishmentCode']),
      environment: textOf(issuer['environment'])
    }
  }
}

// The masks of a receiver as a document keeps them in the clear beside its sealed receiver (Step 7.3-S11b-2): a row with these three columns
// set is listed without opening anything. The time says "calculated", so a receiver with no name or tax id is not calculated again.
export function maskColumnsOf(receiver: { name?: string | null; taxId?: string | null }): {
  receiverNameMasked: string | null
  receiverTaxIdMasked: string | null
  receiverMaskedAt: Date
} {
  return {
    receiverNameMasked: maskReceiverName(receiver.name),
    receiverTaxIdMasked: maskReceiverTaxId(receiver.taxId),
    receiverMaskedAt: new Date()
  }
}

// What the list and the detail of a document show of its receiver, from the opened receiver (the row with no masks yet)
export function maskedReceiverView(receiver: FiscalReceiver): {
  name: string | null
  taxIdMasked: string | null
  complete: boolean
} {
  return {
    name: maskReceiverName(receiver.name),
    taxIdMasked: maskReceiverTaxId(receiver.taxId),
    // The same predicate as the stored masks: a name with no letters is no name
    complete: maskReceiverName(receiver.name) !== null
  }
}

const REPORT_HOUR_MS = 3_600_000

// The last instant the event that reports a contingency may be sent: the hours the authority gives after the situation ended
// (the rules of the authority). The clock is the caller's, never read here.
export const reportDeadlineOf = (endedAt: Date, withinHours: number): Date =>
  new Date(endedAt.getTime() + withinHours * REPORT_HOUR_MS)

// Whether the person is to be told that the time to send the event is closing: the share of it that is left is at or under `ratio`
// (a deadline that passed is closing too, the event is owed still)
export const reportDeadlineIsClosing = (
  endedAt: Date,
  withinHours: number,
  now: Date,
  ratio: number
): boolean => {
  const total = withinHours * REPORT_HOUR_MS
  return reportDeadlineOf(endedAt, withinHours).getTime() - now.getTime() <= total * ratio
}

// The states of a guide whose goods are on their way or were: from the label to the delivery and the way back. Not a guide being made, one
// that failed, one in the middle of a cancellation or cancelled, nor one whose outcome is unknown: they back nothing, and a note made for
// them (a retry, a backfill) would back goods that do not travel.
export const SHIPMENT_STATES_THAT_BACK_GOODS: readonly string[] = [
  ShipmentStatus.LABEL_CREATED,
  ShipmentStatus.PICKED_UP,
  ShipmentStatus.IN_TRANSIT,
  ShipmentStatus.OUT_FOR_DELIVERY,
  ShipmentStatus.FAILED_ATTEMPT,
  ShipmentStatus.DELIVERED,
  ShipmentStatus.RETURNING,
  ShipmentStatus.RETURNED
]
