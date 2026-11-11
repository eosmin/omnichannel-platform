import type { TransferLineInput, TransferLineView, TransferView } from '@platform/api-client'
import { InventoryLimits, type TransferShortageAction, TransferStatus } from '@platform/core/domain'

// The rules of the transfer screens that need no React: what a draft sends, what a receipt sends, which units are
// short, and what each status allows (TDD_16 §4.5). The api checks all of it again; this keeps a person from sending
// what it would refuse.

// A whole number of units from 1 up to the most a movement holds, or null (empty, a fraction, a letter, zero)
export function parseQuantity(text: string): number | null {
  const trimmed = text.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const value = Number(trimmed)
  return value >= 1 && value <= InventoryLimits.MAX_MOVEMENT_QUANTITY ? value : null
}

// ---- The draft -----------------------------------------------------------------------------------------------

export interface DraftLine {
  // productId:variantId, one line per item
  key: string
  storeId: string
  productId: string
  variantId: string | null
  productName: string
  variantName: string | null
  sku: string | null
  // What the person typed; checked on save
  quantity: string
}

export const draftLineKey = (productId: string, variantId: string | null): string =>
  `${productId}:${variantId ?? ''}`

export const draftLinesOf = (transfer: TransferView): DraftLine[] =>
  transfer.lines.map(line => ({
    key: draftLineKey(line.productId, line.variantId),
    storeId: line.storeId,
    productId: line.productId,
    variantId: line.variantId,
    productName: line.productName,
    variantName: line.variantName,
    sku: line.sku,
    quantity: String(line.quantity)
  }))

// An item added once more adds to its line (an item is named once in a transfer), up to the most a line holds
export function addToDraft(lines: readonly DraftLine[], added: DraftLine): DraftLine[] {
  const found = lines.find(line => line.key === added.key)
  if (found === undefined) return [...lines, added]
  const total = (parseQuantity(found.quantity) ?? 0) + (parseQuantity(added.quantity) ?? 0)
  const capped = Math.min(total, InventoryLimits.MAX_MOVEMENT_QUANTITY)
  return lines.map(line => (line.key === added.key ? { ...line, quantity: String(capped) } : line))
}

export type DraftLinesResult =
  | { ok: true; lines: TransferLineInput[] }
  // The first line whose quantity is not a whole number of units
  | { ok: false; wrongKey: string }

export function draftInputOf(lines: readonly DraftLine[]): DraftLinesResult {
  const sent: TransferLineInput[] = []
  for (const line of lines) {
    const quantity = parseQuantity(line.quantity)
    if (quantity === null) return { ok: false, wrongKey: line.key }
    sent.push({
      productId: line.productId,
      ...(line.variantId === null ? {} : { variantId: line.variantId }),
      quantity
    })
  }
  return { ok: true, lines: sent }
}

// Whether the lines on screen differ from the ones the transfer holds (the order does not matter)
export function draftChanged(lines: readonly DraftLine[], transfer: TransferView): boolean {
  if (transfer.lines.length !== lines.length) return true
  const now = new Map(lines.map(line => [line.key, parseQuantity(line.quantity)]))
  return transfer.lines.some(line => {
    const key = draftLineKey(line.productId, line.variantId)
    return now.get(key) !== line.quantity
  })
}

// ---- The receipt ---------------------------------------------------------------------------------------------

// The units that reach the door, line by line: the text of each box, by line id
export type ReceiptEntries = Readonly<Record<string, string>>

export const pendingLines = (lines: readonly TransferLineView[]): TransferLineView[] =>
  lines.filter(line => line.pendingQuantity > 0)

// Everything that is still on its way arrives
export function allPendingOf(lines: readonly TransferLineView[]): ReceiptEntries {
  return Object.fromEntries(
    pendingLines(lines).map(line => [line.id, String(line.pendingQuantity)])
  )
}

export const NO_UNITS = '0'

// A box holds nothing (the line is not part of this receipt), a number, or nonsense
function unitsOf(text: string | undefined): number | null {
  if (text === undefined || text.trim() === '' || text.trim() === NO_UNITS) return 0
  return parseQuantity(text)
}

export type ReceiptResult =
  | { ok: true; lines: { lineId: string; quantity: number }[] }
  // The first line whose box is not a whole number, or holds more than what is pending
  | { ok: false; wrongLineId: string }
  | { ok: false; wrongLineId: null }

export function receiptOf(
  lines: readonly TransferLineView[],
  entries: ReceiptEntries
): ReceiptResult {
  const received: { lineId: string; quantity: number }[] = []
  for (const line of lines) {
    const quantity = unitsOf(entries[line.id])
    if (quantity === null || quantity > line.pendingQuantity) {
      return { ok: false, wrongLineId: line.id }
    }
    if (quantity > 0) received.push({ lineId: line.id, quantity })
  }
  // Nothing typed is not a receipt
  return received.length === 0 ? { ok: false, wrongLineId: null } : { ok: true, lines: received }
}

// One more unit of a line, never past what is pending
export function addOneUnit(line: TransferLineView, entries: ReceiptEntries): ReceiptEntries {
  const current = unitsOf(entries[line.id]) ?? 0
  return { ...entries, [line.id]: String(Math.min(current + 1, line.pendingQuantity)) }
}

// A scanned or typed code names an item by its SKU (the variant's own, or the product's), whatever the letter case.
// A code that two lines share goes to the first that still has units to come.
export function lineOfCode(
  lines: readonly TransferLineView[],
  code: string
): TransferLineView | null {
  const wanted = code.trim().toLowerCase()
  if (wanted === '') return null
  const matches = lines.filter(line => line.sku !== null && line.sku.toLowerCase() === wanted)
  return matches.find(line => line.pendingQuantity > 0) ?? matches[0] ?? null
}

// The lines whose name or SKU holds the text (the search box of the receipt)
export function linesMatching(
  lines: readonly TransferLineView[],
  text: string
): TransferLineView[] {
  const wanted = text.trim().toLowerCase()
  if (wanted === '') return [...lines]
  return lines.filter(line =>
    [line.productName, line.variantName ?? '', line.sku ?? ''].some(part =>
      part.toLowerCase().includes(wanted)
    )
  )
}

// ---- Closing with a shortage ---------------------------------------------------------------------------------

// What is still on its way when the person gives up waiting
export const shortLinesOf = pendingLines

export type ShortageChoices = Readonly<Record<string, TransferShortageAction | undefined>>

// Every short line has its choice, and only those: null while one is missing
export function closeInputOf(
  lines: readonly TransferLineView[],
  choices: ShortageChoices
): { lineId: string; action: TransferShortageAction }[] | null {
  const sent: { lineId: string; action: TransferShortageAction }[] = []
  for (const line of shortLinesOf(lines)) {
    const action = choices[line.id]
    if (action === undefined) return null
    sent.push({ lineId: line.id, action })
  }
  return sent
}

// ---- What each status allows ---------------------------------------------------------------------------------

export interface TransferActions {
  edit: boolean
  dispatch: boolean
  receive: boolean
  close: boolean
  cancel: boolean
}

// The buttons of a transfer: its status says which step it is at, the permissions of the person which of them they
// may press. The api decides in the end; this only keeps the screen from offering what is certain to be refused.
export function actionsOf(
  status: TransferStatus,
  may: { manage: boolean; receive: boolean }
): TransferActions {
  const draft = status === TransferStatus.DRAFT
  const onItsWay = status === TransferStatus.IN_TRANSIT
  return {
    edit: draft && may.manage,
    dispatch: draft && may.manage,
    receive: onItsWay && may.receive,
    close: onItsWay && may.receive,
    cancel: (draft || onItsWay) && may.manage
  }
}
