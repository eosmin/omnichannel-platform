import {
  FiscalDocumentImmutableStatuses,
  FiscalDocumentStatus,
  FiscalDocumentStatusTransitions
} from '@platform/core/domain'
import type { FiscalLine, FiscalReceiver } from '@platform/fiscal/sdk'

// The pure rules of the lifecycle of a fiscal document (TDD_18 §8.3): no database, no provider.

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

export interface OrderLineRow {
  productName: string
  variantName: string | null
  quantity: number
  unitPriceCents: number
  taxRateBps: number | null
  taxCents: number | null
}

// The lines of the document from the lines of the order and the tax snapshot of Step 4B.3b: the amounts are the order's, never
// recomputed here. A line of an order that predates the tax snapshot (null) carries no tax. `totalCents` is the line before its share of
// the order's discount, which travels once, as `discountCents` of the whole document (`FiscalBuildInput`).
export function documentLines(rows: readonly OrderLineRow[]): FiscalLine[] {
  return rows.map(row => ({
    description:
      row.variantName === null ? row.productName : `${row.productName} (${row.variantName})`,
    quantity: row.quantity,
    unitPriceCents: row.unitPriceCents,
    // A rate with no tax amount is a partial snapshot: the line says no rate rather than a rate with no tax
    taxRateBps: row.taxCents === null ? null : row.taxRateBps,
    taxCents: row.taxCents ?? 0,
    totalCents: row.quantity * row.unitPriceCents
  }))
}

const RECEIVER_FIELDS = ['name', 'taxId', 'registrationId', 'email', 'phone'] as const

// What is stored of the receiver, as a plain record of strings (customer data: it is encrypted before it is kept)
export function receiverRecord(receiver: FiscalReceiver): Record<string, unknown> {
  const record: Record<string, unknown> = {}
  for (const field of RECEIVER_FIELDS) {
    const value = receiver[field]
    if (value !== null && value.trim() !== '') record[field] = value.trim()
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
    phone: text('phone')
  }
}

// The tax id as the screens and the audit see it: the last characters only (a third of it at most), so a person can tell two receivers apart
export function maskTaxId(taxId: string | null): string | null {
  if (taxId === null) return null
  // A third of it at most, and never more than four characters: a short id shows almost nothing
  const shown = Math.min(4, Math.floor(taxId.length / 3))
  return `${'*'.repeat(taxId.length - shown)}${shown === 0 ? '' : taxId.slice(-shown)}`
}
