// The states of the shipping module change in ONE place each (TDD_17 §8, the same kind of rule as the
// conversation.status selector): the service that owns the state checks the transition table, writes the history and
// emits the event, and a write from anywhere else skips all three. Reading is free; so is any other column.
//
//   shipment.status, shipment.codStatus, pickupRequest.status, orderReturn.status, codRemittance.status (and any raw
//   UPDATE or INSERT into those four tables)
//     -> libs/core/shipping (ShippingService, ReturnsService, RemittancesService)
//   order.priceApprovalStatus
//     -> apps/api/src/modules/orders (OrdersService)
//
// The development fixtures (libs/core/database/src/dev-fixtures.ts) and the specs write as the owner of a database and
// are the other places (their blocks in eslint.config.js leave these out). Known limit: a write whose data is built elsewhere (`data: row`, a spread) or sits
// inside a nested relation write is not seen by a selector; the owning service and the review are what hold that.

const WRITES =
  '(create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert)'

// The model of a call: `tx.shipment`, `shipment`, or `tx['shipment']`
function onModel(models) {
  return `:matches([callee.object.property.name=/^(${models})$/], [callee.object.property.value=/^(${models})$/], [callee.object.name=/^(${models})$/])`
}

// A field written as a key of the data of a write: `data`, or the `create` and `update` of an upsert, or each row
// of a createMany. A computed key is a variable, not the field, unless it is a string literal
function fieldWrite(models, field) {
  const call = `CallExpression[callee.property.name=/^${WRITES}$/]${onModel(models)}`
  const key = `Property:matches([computed=false][key.name=/^${field}$/], [key.value=/^${field}$/])`
  return [
    `${call} > ObjectExpression > Property[key.name=/^(data|create|update)$/] > ObjectExpression > ${key}`,
    `${call} > ObjectExpression > Property[key.name='data'] > ArrayExpression > ObjectExpression > ${key}`
  ]
}

// Raw SQL. A template is cut into pieces at each ${...}, and a rule sees one piece at a time, so it cannot tie a
// column to its table across a value: a table the owner alone writes is banned as a whole (any UPDATE or INSERT
// into it, with an alias, ONLY or quotes), and for a column of a shared table the SET list is read in each piece
// (a piece that has SET before the column, or that continues the list with `, column =`).
function sqlOwnedTable(table) {
  return [`/\\b(UPDATE|INSERT\\s+INTO)\\s+(ONLY\\s+)?"?(public"?\\.)?"?${table}"?\\b/i`]
}
function sqlSharedColumn(columns) {
  const col = `"?(${columns})"?`
  return [`/\\bSET\\b(?:(?!\\bWHERE\\b)[^;])*?\\b${col}\\s*=/i`, `/,\\s*${col}\\s*=/i`]
}

function bansFor({ models, fields, regexes, owner, label }) {
  const message = `${label} changes only through ${owner}: it checks the transition table, writes the history and emits the event`
  const sqlMessage = `${label} changes only through ${owner}: no SQL against it`
  return [
    ...fieldWrite(models, `(${fields})`).map(selector => ({ selector, message })),
    ...regexes.flatMap(regex => [
      { selector: `TemplateElement[value.raw=${regex}]`, message: sqlMessage },
      { selector: `Literal[value=${regex}]`, message: sqlMessage }
    ])
  ]
}

// Owned by libs/core/shipping
const shippingStateBans = [
  ...bansFor({
    models: 'shipment',
    fields: 'status|codStatus',
    regexes: sqlOwnedTable('shipments'),
    owner: 'ShippingService (libs/core/shipping)',
    label: 'shipment.status and shipment.codStatus'
  }),
  ...bansFor({
    models: 'pickupRequest',
    fields: 'status',
    regexes: sqlOwnedTable('pickup_requests'),
    owner: 'ShippingService (libs/core/shipping)',
    label: 'pickupRequest.status'
  }),
  ...bansFor({
    models: 'orderReturn',
    fields: 'status',
    regexes: sqlOwnedTable('order_returns'),
    owner: 'ReturnsService (libs/core/shipping)',
    label: 'orderReturn.status'
  }),
  ...bansFor({
    models: 'codRemittance',
    fields: 'status',
    regexes: sqlOwnedTable('cod_remittances'),
    owner: 'RemittancesService (libs/core/shipping)',
    label: 'codRemittance.status'
  })
]

// Owned by OrdersService (a shared table: only the column is its)
const orderPriceApprovalBans = bansFor({
  models: 'order',
  fields: 'priceApprovalStatus',
  regexes: sqlSharedColumn('price_approval_status'),
  owner: 'OrdersService (apps/api/src/modules/orders)',
  label: 'order.priceApprovalStatus'
})

module.exports = { shippingStateBans, orderPriceApprovalBans }
