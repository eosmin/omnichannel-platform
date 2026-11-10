// The stock of the platform changes in ONE place (TDD_16 §8): InventoryService, in libs/core/inventory, which takes
// the row lock, keeps the level and the ledger in step in one transaction and refuses what no setting allows. The
// development fixtures and the specs write as the owner of a database and are the other two places (their blocks
// below leave this out). Reading is free; so is any other model.
const INVENTORY_TABLES = '(inventoryLevel|inventoryMovement)'
const INVENTORY_WRITES =
  '(create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert|delete|deleteMany)'
const INVENTORY_SQL =
  '/\\b(INSERT\\s+INTO|UPDATE|DELETE\\s+FROM|TRUNCATE(\\s+TABLE)?)\\s+"?(public"?\\.)?"?inventory_(levels|movements)\\b/i'
const inventoryWriteBans = [
  {
    selector: `CallExpression[callee.property.name=/^${INVENTORY_WRITES}$/]:matches([callee.object.property.name=/^${INVENTORY_TABLES}$/], [callee.object.name=/^${INVENTORY_TABLES}$/])`,
    message:
      'Stock changes only through InventoryService (libs/core/inventory): it keeps the level and the ledger together'
  },
  {
    selector: `TemplateElement[value.raw=${INVENTORY_SQL}]`,
    message:
      'Stock changes only through InventoryService (libs/core/inventory): no SQL against inventory_levels or inventory_movements'
  },
  {
    selector: `Literal[value=${INVENTORY_SQL}]`,
    message:
      'Stock changes only through InventoryService (libs/core/inventory): no SQL against inventory_levels or inventory_movements'
  }
]

module.exports = { inventoryWriteBans }
