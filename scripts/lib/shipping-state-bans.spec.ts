import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'

import { Linter } from 'eslint'
import { parser } from 'typescript-eslint'

// The bans of eslint.config.js on writing the states of the shipping module outside their service (TDD_17 §8), run as
// the linter runs them
const { shippingStateBans, orderPriceApprovalBans } = createRequire(__filename)(
  '../../eslint-shipping-bans.cjs'
) as {
  shippingStateBans: { selector: string; message: string }[]
  orderPriceApprovalBans: { selector: string; message: string }[]
}

const linter = new Linter({ configType: 'flat' })

function messagesFor(code: string, bans: { selector: string; message: string }[]) {
  return linter.verify(
    code,
    [
      {
        files: ['**/*.ts'],
        languageOptions: { parser },
        rules: { 'no-restricted-syntax': ['error', ...bans] }
      }
    ],
    'probe.ts'
  )
}

const linesFlagged = (code: string, bans = shippingStateBans): number[] =>
  messagesFor(code, bans)
    .map(message => message.line)
    .sort((a, b) => a - b)

describe('the ban on writing the states of the shipping module outside their service', () => {
  it.each([
    [
      'the status of a shipment',
      'await tx.shipment.update({ where: { id }, data: { status: next } })'
    ],
    [
      'the COD status of a shipment',
      "await prisma.client.shipment.updateMany({ where, data: { codStatus: 'pending_remittance' } })"
    ],
    [
      'a shipment created with its first status',
      "await tx.shipment.create({ data: { status: 'creating' } })"
    ],
    ['a shorthand', 'await tx.shipment.update({ where, data: { status } })'],
    ['a quoted key', "await tx.shipment.update({ where, data: { 'status': next } })"],
    [
      'the update side of an upsert',
      'await tx.shipment.upsert({ where, create: { id }, update: { status: next } })'
    ],
    [
      'the create side of an upsert',
      'await tx.shipment.upsert({ where, create: { status: next }, update: {} })'
    ],
    [
      'each row of a createMany',
      'await tx.shipment.createMany({ data: [{ orderId: a }, { orderId: b, status: next }] })'
    ],
    ['the status of a pickup', 'await tx.pickupRequest.update({ where, data: { status: next } })'],
    ['the status of a return', 'await tx.orderReturn.update({ where, data: { status: next } })'],
    [
      'the status of a remittance',
      'await remittances.codRemittance.update({ where, data: { status: next } })'
    ],
    ['a destructured model', 'await shipment.update({ where, data: { status: next } })'],
    [
      'createManyAndReturn',
      'await tx.pickupRequest.createManyAndReturn({ data: [{ status: next }] })'
    ]
  ])('refuses %s', (_label, statement) => {
    expect(linesFlagged(statement)).toEqual([1])
  })

  it.each([
    [
      'an UPDATE with the status in the SET',
      'await tx.$executeRaw`UPDATE shipments SET status = ${s} WHERE id = ${id}`'
    ],
    [
      'a status after a value (the template is cut at each value)',
      'await tx.$executeRaw`UPDATE shipments SET failed_attempts = ${n}, status = ${s} WHERE id = ${id}`'
    ],
    [
      "a column that is not the status: the table is the owner's",
      'await tx.$executeRaw`UPDATE shipments SET tracking_url = ${url} WHERE id = ${id}`'
    ],
    [
      'a quoted table and column',
      'await tx.$executeRawUnsafe(\'UPDATE "shipments" SET "cod_status" = $1 WHERE id = $2\')'
    ],
    ['an alias', 'await tx.$executeRaw`UPDATE shipments AS s SET status = ${s}`'],
    ['ONLY', 'await tx.$executeRaw`UPDATE ONLY shipments SET status = ${s}`'],
    ['the public schema', 'await tx.$executeRaw`update public.pickup_requests set status = ${s}`'],
    ['a return', 'await tx.$executeRaw`UPDATE order_returns SET status = ${s}`'],
    ['a remittance', 'await tx.$executeRaw`UPDATE cod_remittances SET note = 1, status = ${s}`'],
    [
      'an INSERT into the table',
      'await tx.$executeRaw`INSERT INTO shipments (id, status) VALUES (1, 2)`'
    ],
    [
      'an INSERT into a quoted table',
      'await tx.$executeRawUnsafe(\'INSERT INTO "order_returns" (id) VALUES (1)\')'
    ]
  ])('refuses raw SQL: %s', (_label, statement) => {
    expect(linesFlagged(statement)).toEqual([1])
  })

  it.each([
    ['a computed access', "await tx['shipment'].update({ where, data: { status: next } })"],
    ['a string key', "await tx.shipment.update({ where, data: { ['status']: next } })"]
  ])('refuses %s', (_label, statement) => {
    expect(linesFlagged(statement)).toEqual([1])
  })

  it('does not take a variable used as a key for the field', () => {
    expect(linesFlagged('await tx.shipment.update({ where, data: { [status]: next } })')).toEqual(
      []
    )
  })

  it.each([
    ['a read of a shipment', 'await tx.shipment.findMany({ where: { status: next } })'],
    ['a count with a status filter', 'await tx.shipment.count({ where: { status: next } })'],
    [
      'the filter of an update',
      'await tx.shipment.updateMany({ where: { status: prev }, data: { failedAttempts: 1 } })'
    ],
    [
      'another column of a shipment',
      'await tx.shipment.update({ where, data: { trackingUrl: url } })'
    ],
    ['the status of the history', 'await tx.shipmentEvent.create({ data: { status: next } })'],
    ['the status of a bulk job', 'await tx.bulkLabelJob.update({ where, data: { status: next } })'],
    ['the status of an order', 'await tx.order.update({ where, data: { status: next } })'],
    ['a select in SQL', 'await tx.$queryRaw`SELECT status FROM shipments WHERE status = ${s}`'],
    ['the history table', 'await tx.$executeRaw`UPDATE shipment_events SET status = ${s}`'],
    [
      'a table whose name only starts the same',
      'await tx.$executeRaw`UPDATE shipments_archive SET status = 1`'
    ],
    [
      'an INSERT into the history',
      'await tx.$executeRaw`INSERT INTO shipment_events (id) VALUES (1)`'
    ]
  ])('allows %s', (_label, statement) => {
    expect(linesFlagged(statement)).toEqual([])
  })

  it('does not look at the price approval: that is the other service', () => {
    expect(
      linesFlagged('await tx.order.update({ where, data: { priceApprovalStatus: next } })')
    ).toEqual([])
  })
})

describe('the ban on writing the approval of a price outside OrdersService', () => {
  it.each([
    ['an update', "await tx.order.update({ where, data: { priceApprovalStatus: 'approved' } })"],
    ['an updateMany', 'await tx.order.updateMany({ where, data: { priceApprovalStatus: next } })'],
    ['a create', 'await tx.order.create({ data: { priceApprovalStatus: next } })'],
    ['a shorthand', 'await tx.order.update({ where, data: { priceApprovalStatus } })'],
    [
      'an UPDATE in SQL',
      'await tx.$executeRaw`UPDATE orders SET price_approval_status = ${s} WHERE id = ${id}`'
    ],
    [
      'the approval after a value in the SET list',
      'await tx.$executeRaw`UPDATE orders SET status = ${a}, price_approval_status = ${s} WHERE id = ${id}`'
    ],
    [
      'a quoted column',
      'await tx.$executeRaw`UPDATE orders SET "price_approval_status" = ${s} WHERE id = ${id}`'
    ]
  ])('refuses %s', (_label, statement) => {
    expect(linesFlagged(statement, orderPriceApprovalBans)).toEqual([1])
  })

  it.each([
    ['the status of an order', 'await tx.order.update({ where, data: { status: next } })'],
    ['a read of the approval', 'await tx.order.findMany({ where: { priceApprovalStatus: next } })'],
    ['an INSERT of an order', 'await tx.$executeRaw`INSERT INTO orders (id) VALUES (1)`'],
    [
      'an UPDATE of the status of an order',
      'await tx.$executeRaw`UPDATE orders SET status = ${s}, note = ${n} WHERE id = ${id}`'
    ],
    [
      'the approval only in a WHERE',
      'await tx.$executeRaw`UPDATE orders SET status = ${s} WHERE price_approval_status = ${p}`'
    ],
    ['the status of a shipment', 'await tx.shipment.update({ where, data: { status: next } })']
  ])('allows %s', (_label, statement) => {
    expect(linesFlagged(statement, orderPriceApprovalBans)).toEqual([])
  })
})

// Which bans apply to which file, as ESLint resolves the config of the repository: a block that replaces the rule
// without them (a later block in eslint.config.js) would switch a ban off for its files
describe('where the bans of the shipping states apply', () => {
  const root = path.resolve(__dirname, '../..')
  const files = [
    'apps/api/src/modules/customers/customers.service.ts',
    'apps/worker/src/processors/example.processor.ts',
    'libs/core/inventory/src/inventory.service.ts',
    'libs/core/messaging/src/example.ts',
    'libs/core/shipping/src/shipping.service.ts',
    'libs/core/shipping/src/shipping.service.spec.ts',
    'apps/api/src/modules/orders/orders.service.ts',
    'apps/api/src/modules/orders/orders.service.spec.ts',
    'tests/security/tenant-isolation.spec.ts'
  ]
  // ESLint loads the config as a module, which jest cannot: a plain node process resolves it, as `eslint` does
  const resolved = JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { ESLint } from 'eslint'
         const eslint = new ESLint({ cwd: process.argv[1] })
         const out = {}
         for (const file of JSON.parse(process.argv[2])) {
           const config = await eslint.calculateConfigForFile(process.argv[1] + '/' + file)
           out[file] = (config.rules['no-restricted-syntax'] ?? []).flatMap(entry => entry && entry.selector ? [entry.selector] : [])
         }
         console.log(JSON.stringify(out))`,
        root,
        JSON.stringify(files)
      ],
      { cwd: root, encoding: 'utf8' }
    )
  ) as Record<string, string[]>
  const selectorsOf = (file: string): Set<string> => new Set(resolved[file])
  const has = (selectors: Set<string>, bans: { selector: string }[]): boolean =>
    bans.every(ban => selectors.has(ban.selector))
  const lacks = (selectors: Set<string>, bans: { selector: string }[]): boolean =>
    bans.every(ban => !selectors.has(ban.selector))

  it.each([
    ['a module of the api', 'apps/api/src/modules/customers/customers.service.ts'],
    ['the worker', 'apps/worker/src/processors/example.processor.ts'],
    ['the inventory engine', 'libs/core/inventory/src/inventory.service.ts'],
    ['the messaging lib', 'libs/core/messaging/src/example.ts']
  ])('bans both outside the owners: %s', (_label, file) => {
    const selectors = selectorsOf(file)
    expect(has(selectors, shippingStateBans)).toBe(true)
    expect(has(selectors, orderPriceApprovalBans)).toBe(true)
  })

  it('leaves the six states to their services and bans the other service there', () => {
    const shipping = selectorsOf('libs/core/shipping/src/shipping.service.ts')
    expect(lacks(shipping, shippingStateBans)).toBe(true)
    expect(has(shipping, orderPriceApprovalBans)).toBe(true)

    const orders = selectorsOf('apps/api/src/modules/orders/orders.service.ts')
    expect(lacks(orders, orderPriceApprovalBans)).toBe(true)
    expect(has(orders, shippingStateBans)).toBe(true)
  })

  it('leaves the specs alone', () => {
    for (const file of [
      'libs/core/shipping/src/shipping.service.spec.ts',
      'apps/api/src/modules/orders/orders.service.spec.ts',
      'tests/security/tenant-isolation.spec.ts'
    ]) {
      const selectors = selectorsOf(file)
      expect(lacks(selectors, shippingStateBans)).toBe(true)
      expect(lacks(selectors, orderPriceApprovalBans)).toBe(true)
    }
  })
})
