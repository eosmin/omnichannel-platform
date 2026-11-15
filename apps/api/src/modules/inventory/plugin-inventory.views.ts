import type { MovementPage, MovementView } from './inventory.views'

// A stock movement as a plugin reads it: the fields of the screen except `createdBy`, the id of the person of the team who made it,
// and `createdByPluginId`, the plugin that made it (another installation's business, and the key is absent for every movement rather
// than for some). A plugin has no scope that was reviewed to name a member of the team. The fields are named one by one, so a column
// added to `MovementView` does not reach a plugin until someone decides it should.
export type PluginMovementView = Omit<MovementView, 'createdBy' | 'createdByPluginId'>
export type PluginMovementPage = Omit<MovementPage, 'data'> & { data: PluginMovementView[] }

export function pluginMovementView(movement: MovementView): PluginMovementView {
  const view: PluginMovementView = {
    id: movement.id,
    productId: movement.productId,
    variantId: movement.variantId,
    warehouseId: movement.warehouseId,
    type: movement.type,
    quantity: movement.quantity,
    reason: movement.reason,
    note: movement.note,
    referenceType: movement.referenceType,
    referenceId: movement.referenceId,
    onHandAfter: movement.onHandAfter,
    reservedAfter: movement.reservedAfter,
    createdAt: movement.createdAt
  }
  // Present only for who may see the cost (the key is absent for the others, as on the screen)
  return movement.unitCostCents === undefined
    ? view
    : { ...view, unitCostCents: movement.unitCostCents }
}

export function pluginMovementPage(page: MovementPage): PluginMovementPage {
  return { ...page, data: page.data.map(pluginMovementView) }
}
