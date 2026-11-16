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

// A person may fix the receiver while the document is waiting or was refused, never after the authority accepted it
export const receiverEditable = (status: FiscalDocumentStatus): boolean =>
  status === FiscalDocumentStatus.QUEUED || status === FiscalDocumentStatus.REJECTED

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
// recomputed here. A line of an order that predates the tax snapshot (null) carries no tax. `lineTotalCents` is the line before its
// share of the order's discount, which the document carries once, in `discountCents` of the first line that can hold it.
export function documentLines(rows: readonly OrderLineRow[]): FiscalLine[] {
  return rows.map(row => ({
    description:
      row.variantName === null ? row.productName : `${row.productName} (${row.variantName})`,
    quantity: row.quantity,
    unitPriceCents: row.unitPriceCents,
    discountCents: 0,
    taxRateBps: row.taxRateBps,
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
  if (receiver.address !== null && Object.keys(receiver.address).length > 0) {
    record['address'] = receiver.address
  }
  return record
}

export function receiverOf(record: Readonly<Record<string, unknown>>): FiscalReceiver {
  const text = (key: string): string | null => {
    const value = record[key]
    return typeof value === 'string' && value !== '' ? value : null
  }
  const address = record['address']
  const clean: Record<string, string> = {}
  if (typeof address === 'object' && address !== null) {
    for (const [key, value] of Object.entries(address)) {
      if (typeof value === 'string' && value !== '') clean[key] = value
    }
  }
  return {
    name: text('name'),
    taxId: text('taxId'),
    registrationId: text('registrationId'),
    address: Object.keys(clean).length > 0 ? clean : null,
    email: text('email'),
    phone: text('phone')
  }
}

// The tax id as the screens and the audit see it: the last characters only, so a person can tell two receivers apart
export function maskTaxId(taxId: string | null): string | null {
  if (taxId === null) return null
  if (taxId.length <= 4) return '*'.repeat(taxId.length)
  return `${'*'.repeat(taxId.length - 4)}${taxId.slice(-4)}`
}
