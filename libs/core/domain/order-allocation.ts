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
