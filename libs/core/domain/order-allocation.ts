// Which warehouse serves how many units of an order line (TDD_16 §4.1). Pure: the service reads the available stock of
// each warehouse the store sells from, in the order of `StoreWarehouse.priority`, and writes what this answers.

export interface WarehouseAvailability {
  readonly warehouseId: string
  // onHand - reserved, as the levels say; it may be negative in a store that allows negative stock
  readonly available: number
}

export interface LineAllocation {
  readonly warehouseId: string
  readonly quantity: number
}

export interface PlanAllocationInput {
  readonly quantity: number
  // Ordered by priority: the first one is the highest priority
  readonly warehouses: readonly WarehouseAvailability[]
  readonly allowSplitFulfillment: boolean
  readonly allowNegativeStock: boolean
}

export type AllocationPlan =
  | { readonly ok: true; readonly allocations: readonly LineAllocation[] }
  // What the client reads from the 409: the stock each warehouse could give, never below zero
  | { readonly ok: false; readonly availableByWarehouse: readonly WarehouseAvailability[] }

// 1. the first warehouse that covers the whole line gets all of it (so shipments stay simple whenever they can);
// 2. else, with split on, walk the warehouses by priority and take what each has until the line is met;
// 3. else, or when all together are still short, refuse, unless the store allows negative stock: then what is missing
//    goes to the highest-priority warehouse, whose available stock goes negative.
export function planLineAllocation({
  quantity,
  warehouses,
  allowSplitFulfillment,
  allowNegativeStock
}: PlanAllocationInput): AllocationPlan {
  const first = warehouses[0]
  const refused = (): AllocationPlan => ({
    ok: false,
    availableByWarehouse: warehouses.map(({ warehouseId, available }) => ({
      warehouseId,
      available: Math.max(available, 0)
    }))
  })
  // A store that sells from no warehouse has nowhere to take the units from, whatever its setting
  if (first === undefined || !Number.isInteger(quantity) || quantity < 1) return refused()

  const whole = warehouses.find(warehouse => warehouse.available >= quantity)
  if (whole !== undefined) {
    return { ok: true, allocations: [{ warehouseId: whole.warehouseId, quantity }] }
  }

  if (allowSplitFulfillment) {
    const taken = new Map<string, number>()
    let missing = quantity
    for (const { warehouseId, available } of warehouses) {
      if (missing === 0) break
      const take = Math.min(Math.max(available, 0), missing)
      if (take > 0) {
        taken.set(warehouseId, take)
        missing -= take
      }
    }
    if (missing > 0) {
      if (!allowNegativeStock) return refused()
      taken.set(first.warehouseId, (taken.get(first.warehouseId) ?? 0) + missing)
    }
    // In priority order, so that two readers of the same plan list the warehouses the same way
    const allocations = warehouses.flatMap(({ warehouseId }) => {
      const units = taken.get(warehouseId)
      return units === undefined ? [] : [{ warehouseId, quantity: units }]
    })
    return { ok: true, allocations }
  }

  return allowNegativeStock
    ? { ok: true, allocations: [{ warehouseId: first.warehouseId, quantity }] }
    : refused()
}

export interface CheckRequestedAllocationInput {
  readonly quantity: number
  // What the agent chose for the line (TDD_16 §4.1 rule 4)
  readonly requested: readonly LineAllocation[]
  // The warehouses the store sells from and that are switched on, with their available stock
  readonly warehouses: readonly WarehouseAvailability[]
  readonly allowSplitFulfillment: boolean
  readonly allowNegativeStock: boolean
}

export type RequestedAllocationCheck =
  | { readonly ok: true; readonly allocations: readonly LineAllocation[] }
  // A warehouse the store does not sell from (or that is off, or another organization's)
  | { readonly ok: false; readonly reason: 'not_linked'; readonly warehouseId: string }
  // The units do not add up to the line, or a warehouse is named twice or with no units
  | { readonly ok: false; readonly reason: 'quantity_mismatch' }
  // Several warehouses in a store that ships each line from one
  | { readonly ok: false; readonly reason: 'split_not_allowed' }
  // A warehouse has less than the units asked of it (only the first warehouse may go short, and only in a store with
  // negative stock, like the planner)
  | {
      readonly ok: false
      readonly reason: 'insufficient'
      readonly availableByWarehouse: readonly WarehouseAvailability[]
    }

// The same rules the planner follows, applied to the choice of the agent: the server never takes a choice on trust, it
// checks that every warehouse is one the store sells from, that the units add up to the line, that a split is allowed
// and that each warehouse has what it is asked for. The answer lists the warehouses in priority order, like the planner.
export function checkRequestedAllocation({
  quantity,
  requested,
  warehouses,
  allowSplitFulfillment,
  allowNegativeStock
}: CheckRequestedAllocationInput): RequestedAllocationCheck {
  const known = new Map(warehouses.map(warehouse => [warehouse.warehouseId, warehouse.available]))
  for (const { warehouseId } of requested) {
    if (!known.has(warehouseId)) return { ok: false, reason: 'not_linked', warehouseId }
  }
  const named = new Set(requested.map(row => row.warehouseId))
  const total = requested.reduce((sum, row) => sum + row.quantity, 0)
  if (
    requested.length === 0 ||
    named.size !== requested.length ||
    requested.some(row => !Number.isInteger(row.quantity) || row.quantity < 1) ||
    total !== quantity
  ) {
    return { ok: false, reason: 'quantity_mismatch' }
  }
  if (requested.length > 1 && !allowSplitFulfillment)
    return { ok: false, reason: 'split_not_allowed' }
  // The planner lets only the highest-priority warehouse go below zero, and only when negative stock is on: a choice
  // follows the same rule, so an agent cannot push any warehouse negative
  const first = warehouses[0]?.warehouseId
  const isShort = requested.some(
    row =>
      (known.get(row.warehouseId) as number) < row.quantity &&
      !(allowNegativeStock && row.warehouseId === first)
  )
  if (isShort) {
    return {
      ok: false,
      reason: 'insufficient',
      availableByWarehouse: warehouses.map(({ warehouseId, available }) => ({
        warehouseId,
        available: Math.max(available, 0)
      }))
    }
  }
  return {
    ok: true,
    allocations: warehouses.flatMap(({ warehouseId }) => {
      const row = requested.find(item => item.warehouseId === warehouseId)
      return row === undefined ? [] : [{ warehouseId, quantity: row.quantity }]
    })
  }
}
