import {
  type CreateOrderInput,
  checkRequestedAllocation,
  type LineAllocation,
  OrderLimits,
  PaymentMethod,
  planLineAllocation,
  type RequestedAllocationCheck,
  RecipientPhones,
  type WarehouseAvailability
} from '@platform/core/domain'

import { parseCents } from '../products/money'

// The state of the create-order form and what it sends. Nothing here reads the DOM or the network. The form never
// sends a total or a status: the server prices the order from the catalog (TDD_17 §4.13) and the only prices a body can
// carry are the shipping fee, the discount and, for a member who may override it, the price of a line.

export interface DraftLine {
  // Stable while the line is on the screen (the product and variant are the identity of the line)
  key: string
  productId: string
  variantId: string | null
  productName: string
  variantName: string | null
  sku: string | null
  catalogPriceCents: number
  // The price an existing line was sold at (an override included): what a member who cannot change prices is shown. Null for a
  // line that is not made yet, which is shown at the catalog price.
  soldPriceCents?: number | null
  // A text field: "" is not filled in yet
  quantity: string
  // The price the agent typed, or null to sell at the catalog price
  priceText: string | null
  priceReason: string
  // Null: the server plans the warehouses by priority; a list: the agent chose them (units as text)
  allocations: Record<string, string> | null
}

export interface DraftForm {
  customerId: string | null
  lines: DraftLine[]
  shippingText: string
  discountText: string
  discountReason: string
  paymentMethod: PaymentMethod
  scheduledDate: string
  phones: string[]
  addressId: string | null
  customerNotes: string
  internalNotes: string
  packingNotes: string
  confirmOnCreate: boolean
}

export type FormField =
  | 'customer'
  | 'lines'
  | 'quantity'
  | 'price'
  | 'priceReason'
  | 'allocations'
  | 'shipping'
  | 'discount'
  | 'discountReason'
  | 'phones'
  | 'scheduledDate'
  // An edit that changes nothing
  | 'nothing'

export interface AllowedBy {
  // ORDERS_OVERRIDE_PRICE: the price of a line may be written
  canOverridePrice: boolean
  // ORDERS_CONFIRM: the order may be confirmed when it is made
  canConfirm: boolean
}

export function emptyForm(): DraftForm {
  return {
    customerId: null,
    lines: [],
    shippingText: '',
    discountText: '',
    discountReason: '',
    paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
    scheduledDate: '',
    phones: [''],
    addressId: null,
    customerNotes: '',
    internalNotes: '',
    packingNotes: '',
    confirmOnCreate: false
  }
}

// The national number of the customer, as the first recipient phone; an empty field when there is none (the agent types it)
export function initialPhones(nationalPhone: string | null): string[] {
  return [nationalPhone === null ? '' : phoneDigits(nationalPhone)]
}

// Digits only, on leaving the field: what is stored is what the carrier receives
export function phoneDigits(text: string): string {
  return text.replace(/\D/g, '')
}

export function canAddPhone(phones: readonly string[]): boolean {
  return phones.length < RecipientPhones.MAX_COUNT
}

// The body of POST /customers from the three fields, or null when all of them are blank (the api needs one)
export function newCustomerBody(values: {
  name: string
  email: string
  phone: string
}): { name?: string; email?: string; phone?: string } | null {
  const body: { name?: string; email?: string; phone?: string } = {}
  for (const key of ['name', 'email', 'phone'] as const) {
    const text = values[key].trim()
    if (text !== '') body[key] = text
  }
  return Object.keys(body).length === 0 ? null : body
}

// The address of the order, copied from a saved address of the customer: the order keeps its own copy (a later edit of the
// customer does not rewrite an order that was promised)
export function shippingAddressOf(address: {
  line1: string
  line2: string | null
  city: string
  state: string | null
  postalCode: string | null
  country: string
}): NonNullable<CreateOrderInput['shippingAddress']> {
  return {
    line1: address.line1,
    ...(address.line2 === null ? {} : { line2: address.line2 }),
    city: address.city,
    ...(address.state === null ? {} : { state: address.state }),
    ...(address.postalCode === null ? {} : { postalCode: address.postalCode }),
    country: address.country
  }
}

// The price a row shows when the member cannot write it, and the one the estimate multiplies
export function shownPriceCents(
  line: Pick<DraftLine, 'catalogPriceCents' | 'soldPriceCents'>
): number {
  return line.soldPriceCents ?? line.catalogPriceCents
}

export function lineKey(productId: string, variantId: string | null): string {
  return `${productId}:${variantId ?? ''}`
}

// The same product and variant twice is one line with the quantities added (the server refuses it as two)
export function addLine(lines: readonly DraftLine[], added: Omit<DraftLine, 'key'>): DraftLine[] {
  const key = lineKey(added.productId, added.variantId)
  const found = lines.find(line => line.key === key)
  if (found === undefined) return [...lines, { ...added, key }]
  return lines.map(line =>
    line.key === key
      ? {
          ...line,
          quantity: String(
            Math.min((parseQuantity(line.quantity) ?? 0) + 1, OrderLimits.MAX_QUANTITY_PER_LINE)
          ),
          // The units changed: a choice of warehouses made for the old quantity no longer adds up
          allocations: null
        }
      : line
  )
}

export function parseQuantity(text: string): number | null {
  if (!/^\d{1,5}$/.test(text.trim())) return null
  const value = Number(text)
  return value >= 1 && value <= OrderLimits.MAX_QUANTITY_PER_LINE ? value : null
}

function parseUnits(text: string): number | null {
  if (!/^\d{1,5}$/.test(text.trim())) return null
  return Number(text)
}

// The units of a line asked of each warehouse, as numbers; the ones left at 0 or empty are not asked
export function chosenAllocations(line: DraftLine): LineAllocation[] | null {
  if (line.allocations === null) return null
  const rows: LineAllocation[] = []
  for (const [warehouseId, text] of Object.entries(line.allocations)) {
    const units = parseUnits(text)
    if (units !== null && units > 0) rows.push({ warehouseId, quantity: units })
  }
  return rows
}

export interface StockRules {
  // The warehouses the store sells from, highest priority first, with the stock of this item in each
  warehouses: readonly WarehouseAvailability[]
  allowSplitFulfillment: boolean
  allowNegativeStock: boolean
}

// What the server would do with the line if nothing is chosen: the plan by priority. Null when no warehouse can serve it
export function plannedAllocations(quantity: number, rules: StockRules): LineAllocation[] | null {
  const plan = planLineAllocation({ quantity, ...rules })
  return plan.ok ? [...plan.allocations] : null
}

// The choice of the agent against the same rules the server applies. The server checks again: this is for the screen
export type AllocationProblem = Extract<RequestedAllocationCheck, { ok: false }>['reason']

export function allocationProblem(line: DraftLine, rules: StockRules): AllocationProblem | null {
  const quantity = parseQuantity(line.quantity)
  const chosen = chosenAllocations(line)
  if (quantity === null || chosen === null) return null
  const check = checkRequestedAllocation({ quantity, requested: chosen, ...rules })
  return check.ok ? null : check.reason
}

export interface WarehouseOfStore {
  id: string
  active: boolean
  stores: readonly { storeId: string; priority: number }[]
}

export interface StockLevelOfItem {
  variantId: string | null
  warehouseId: string
  available: number
}

// The stock rules of one item: the warehouses this store sells from, switched on, in the order of their priority (the
// first is served first), each with what is available of the item (0 where it has no row)
export function stockRulesOf(input: {
  storeId: string
  variantId: string | null
  warehouses: readonly WarehouseOfStore[]
  levels: readonly StockLevelOfItem[]
  allowSplitFulfillment: boolean
  allowNegativeStock: boolean
}): StockRules {
  const linked = input.warehouses.flatMap(warehouse => {
    const link = warehouse.stores.find(store => store.storeId === input.storeId)
    return warehouse.active && link !== undefined ? [{ warehouse, priority: link.priority }] : []
  })
  linked.sort((a, b) => a.priority - b.priority)
  return {
    warehouses: linked.map(({ warehouse }) => ({
      warehouseId: warehouse.id,
      available:
        input.levels.find(
          level => level.warehouseId === warehouse.id && level.variantId === input.variantId
        )?.available ?? 0
    })),
    allowSplitFulfillment: input.allowSplitFulfillment,
    allowNegativeStock: input.allowNegativeStock
  }
}

export type BuildResult =
  { ok: true; value: CreateOrderInput } | { ok: false; field: FormField; line?: string }

// The body of POST /orders from the form, or the first field that is wrong. `stock` holds the rules of the lines whose
// stock is known (the agent may read the inventory): a line without them is sent without a choice of warehouses.
export function buildOrder(
  form: DraftForm,
  allowed: AllowedBy,
  options: { conversationId?: string; stock: ReadonlyMap<string, StockRules> }
): BuildResult {
  if (form.customerId === null) return { ok: false, field: 'customer' }
  if (form.lines.length === 0) return { ok: false, field: 'lines' }

  const items: CreateOrderInput['items'] = []
  for (const line of form.lines) {
    const quantity = parseQuantity(line.quantity)
    if (quantity === null) return { ok: false, field: 'quantity', line: line.key }
    let unitPriceCents: number | undefined
    let priceReason: string | undefined
    if (allowed.canOverridePrice && line.priceText !== null) {
      const cents = parseCents(line.priceText)
      if (cents === null) return { ok: false, field: 'price', line: line.key }
      if (cents !== line.catalogPriceCents) {
        if (line.priceReason.trim() === '')
          return { ok: false, field: 'priceReason', line: line.key }
        unitPriceCents = cents
        priceReason = line.priceReason.trim()
      }
    }
    const chosen = chosenAllocations(line)
    if (chosen !== null) {
      const rules = options.stock.get(line.key)
      if (rules === undefined || allocationProblem(line, rules) !== null) {
        return { ok: false, field: 'allocations', line: line.key }
      }
    }
    items.push({
      productId: line.productId,
      ...(line.variantId === null ? {} : { variantId: line.variantId }),
      quantity,
      ...(unitPriceCents === undefined ? {} : { unitPriceCents }),
      ...(priceReason === undefined ? {} : { priceReason }),
      ...(chosen === null ? {} : { allocations: chosen })
    })
  }

  const shippingCents = form.shippingText.trim() === '' ? 0 : parseCents(form.shippingText)
  if (shippingCents === null) return { ok: false, field: 'shipping' }
  const discountCents = form.discountText.trim() === '' ? 0 : parseCents(form.discountText)
  if (discountCents === null) return { ok: false, field: 'discount' }
  const discountReason = form.discountReason.trim()
  if (discountCents > 0 && discountReason === '') return { ok: false, field: 'discountReason' }

  const phones = form.phones.map(phoneDigits).filter(phone => phone !== '')
  if (
    phones.length === 0 ||
    new Set(phones).size !== phones.length ||
    phones.some(
      phone =>
        phone.length < RecipientPhones.MIN_DIGITS || phone.length > RecipientPhones.MAX_DIGITS
    )
  ) {
    return { ok: false, field: 'phones' }
  }
  if (form.scheduledDate !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(form.scheduledDate)) {
    return { ok: false, field: 'scheduledDate' }
  }

  const note = (text: string): string | undefined => (text.trim() === '' ? undefined : text.trim())
  return {
    ok: true,
    value: {
      customerId: form.customerId,
      ...(options.conversationId === undefined ? {} : { conversationId: options.conversationId }),
      items,
      shippingCents,
      discountCents,
      ...(discountCents > 0 ? { discountReason } : {}),
      paymentMethod: form.paymentMethod,
      recipientPhones: phones,
      customerNotes: note(form.customerNotes),
      internalNotes: note(form.internalNotes),
      packingNotes: note(form.packingNotes),
      scheduledDeliveryDate: form.scheduledDate === '' ? null : form.scheduledDate,
      confirmOnCreate: allowed.canConfirm && form.confirmOnCreate,
      // The form has no choice for it yet (Step 4.14): no message goes to the customer that the agent did not ask for
      sendConfirmationMessage: false
    }
  }
}
