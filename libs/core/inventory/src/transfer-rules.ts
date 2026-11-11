import {
  type TransferMovementKeys,
  TransferNumber,
  type TransferShortageAction,
  type TransferStatus,
  TransferStatusTransitions
} from '@platform/core/domain'

// The rules of a transfer between warehouses that need no database (TDD_16 §4.5): the status machine, the number, the
// keys of its movements, what a receipt and a close do to the lines. TransfersService applies them under the lock of
// the transfer and writes the stock through InventoryService.

export const canMoveTransfer = (from: TransferStatus, to: TransferStatus): boolean =>
  TransferStatusTransitions[from].includes(to)

// "TR-0001", "TR-0002", ... the number after the highest one of the organization; past 9999 it only grows
export function formatTransferNumber(sequence: number): string {
  return `${TransferNumber.PREFIX}${String(sequence).padStart(TransferNumber.MIN_DIGITS, '0')}`
}

// The sequence a number holds, or null when the text is not a number of this format
export function transferSequence(number: string): number | null {
  if (!number.startsWith(TransferNumber.PREFIX)) return null
  const digits = number.slice(TransferNumber.PREFIX.length)
  if (!/^[0-9]+$/.test(digits)) return null
  const value = Number(digits)
  return Number.isSafeInteger(value) ? value : null
}

// The key a movement of a transfer is written under: the same step of the same line is the same movement, so a retry
// (or two requests at once) never applies it twice. A receipt carries the client's receipt key as well.
export function transferMovementKey(
  transferId: string,
  lineId: string,
  kind: (typeof TransferMovementKeys)[keyof typeof TransferMovementKeys],
  receiptKey?: string
): string {
  const base = `transfer:${transferId}:${lineId}:${kind}`
  return receiptKey === undefined ? base : `${base}:${receiptKey}`
}

export interface TransferLineState {
  id: string
  // What was dispatched
  quantity: number
  receivedQuantity: number
}

// The units of the line that have not arrived
export const pendingOf = (line: TransferLineState): number => line.quantity - line.receivedQuantity

export type ReceiptRefusal =
  | { kind: 'empty' }
  | { kind: 'unknown_line'; lineId: string }
  | { kind: 'duplicate_line'; lineId: string }
  | { kind: 'invalid_quantity'; lineId: string }
  | { kind: 'exceeds_dispatched'; lineId: string; pending: number }

export type ReceiptPlan =
  | {
      ok: true
      // What arrives now, and what the line holds after it
      receipts: { lineId: string; quantity: number; receivedAfter: number }[]
      // Every line of the transfer has all its units: the status becomes RECEIVED
      completes: boolean
    }
  | { ok: false; refusal: ReceiptRefusal }

// A receipt names lines of the transfer and a whole number of units for each; the cumulative received quantity of a
// line never goes above what was dispatched. `lines` are ALL the lines of the transfer, so that the answer to "is it
// complete" does not depend on which of them the caller can see.
export function planReceipt(
  lines: readonly TransferLineState[],
  receipt: readonly { lineId: string; quantity: number }[]
): ReceiptPlan {
  if (receipt.length === 0) return { ok: false, refusal: { kind: 'empty' } }
  const byId = new Map(lines.map(line => [line.id, line]))
  const seen = new Set<string>()
  const receipts: { lineId: string; quantity: number; receivedAfter: number }[] = []
  for (const entry of receipt) {
    const line = byId.get(entry.lineId)
    if (line === undefined)
      return { ok: false, refusal: { kind: 'unknown_line', lineId: entry.lineId } }
    if (seen.has(entry.lineId))
      return { ok: false, refusal: { kind: 'duplicate_line', lineId: entry.lineId } }
    seen.add(entry.lineId)
    if (!Number.isInteger(entry.quantity) || entry.quantity < 1) {
      return { ok: false, refusal: { kind: 'invalid_quantity', lineId: entry.lineId } }
    }
    if (entry.quantity > pendingOf(line)) {
      return {
        ok: false,
        refusal: { kind: 'exceeds_dispatched', lineId: entry.lineId, pending: pendingOf(line) }
      }
    }
    receipts.push({
      lineId: entry.lineId,
      quantity: entry.quantity,
      receivedAfter: line.receivedQuantity + entry.quantity
    })
  }
  const arriving = new Map(receipts.map(item => [item.lineId, item.quantity]))
  const completes = lines.every(line => pendingOf(line) - (arriving.get(line.id) ?? 0) === 0)
  return { ok: true, receipts, completes }
}

export type ClosePlan =
  | {
      ok: true
      // The lines that did not arrive in full, with what is done with the units that are missing
      shortages: { lineId: string; missing: number; action: TransferShortageAction }[]
    }
  | {
      ok: false
      refusal:
        | { kind: 'unknown_line'; lineId: string }
        | { kind: 'duplicate_line'; lineId: string }
        | { kind: 'no_shortage'; lineId: string }
        | { kind: 'missing_action'; lineId: string }
    }

// Closing with a shortage: every line that did not arrive in full says what happens to the units that are missing
// (written off, or sent back to the source); a line that arrived in full has nothing to say. Naming a line that is
// complete, or one twice, or leaving a short one out is a mistake, and nothing is closed.
export function planClose(
  lines: readonly TransferLineState[],
  actions: readonly { lineId: string; action: TransferShortageAction }[]
): ClosePlan {
  const byId = new Map(lines.map(line => [line.id, line]))
  const chosen = new Map<string, TransferShortageAction>()
  for (const entry of actions) {
    if (!byId.has(entry.lineId))
      return { ok: false, refusal: { kind: 'unknown_line', lineId: entry.lineId } }
    if (chosen.has(entry.lineId))
      return { ok: false, refusal: { kind: 'duplicate_line', lineId: entry.lineId } }
    chosen.set(entry.lineId, entry.action)
  }
  const shortages: { lineId: string; missing: number; action: TransferShortageAction }[] = []
  for (const line of lines) {
    const missing = pendingOf(line)
    const action = chosen.get(line.id)
    if (missing === 0) {
      if (action !== undefined)
        return { ok: false, refusal: { kind: 'no_shortage', lineId: line.id } }
      continue
    }
    if (action === undefined)
      return { ok: false, refusal: { kind: 'missing_action', lineId: line.id } }
    shortages.push({ lineId: line.id, missing, action })
  }
  return { ok: true, shortages }
}
