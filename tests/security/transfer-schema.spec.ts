import { randomUUID } from 'node:crypto'

import { type OwnerClient } from '@platform/core/database-testing'

import { createProduct, createProductVariant, createTransfer, createWarehouse } from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'

// What the database itself guarantees about transfers (TDD_16 §2, §8), whoever writes: the rules the tenancy of a
// transfer and its lines stand on, so that a bug of the transfers service cannot break them
describe('The tables of transfers', () => {
  const prefix = newRunPrefix()
  let owner: OwnerClient
  let app: Awaited<ReturnType<typeof createTestApp>>
  let ctx: TestContext

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const refused = (statement: Promise<unknown>, constraint: string | RegExp) =>
    expect(statement).rejects.toThrow(constraint)
  const header = (overrides: Record<string, unknown> = {}) => ({
    organizationId: ctx.orgA.id,
    number: `TR-${randomUUID().replace(/\D/g, '').slice(0, 8).padEnd(4, '0')}`,
    fromWarehouseId: ctx.warehouseA.id,
    toWarehouseId: ctx.warehouseASecond.id,
    createdBy: 'test',
    ...overrides
  })

  describe('a transfer', () => {
    it('goes between two warehouses of its own organization, never another one', async () => {
      await refused(
        owner.stockTransfer.create({ data: header({ toWarehouseId: ctx.warehouseB.id }) }),
        /stock_transfers_organization_id_to_warehouse_id_fkey/
      )
      await refused(
        owner.stockTransfer.create({ data: header({ fromWarehouseId: ctx.warehouseB.id }) }),
        /stock_transfers_organization_id_from_warehouse_id_fkey/
      )
      await refused(
        owner.stockTransfer.create({
          data: header({ organizationId: ctx.orgB.id, fromWarehouseId: ctx.warehouseB.id })
        }),
        /stock_transfers_organization_id_to_warehouse_id_fkey/
      )
    })

    it('goes between two different warehouses', async () => {
      await refused(
        owner.stockTransfer.create({ data: header({ toWarehouseId: ctx.warehouseA.id }) }),
        /chk_stock_transfers_warehouses_differ/
      )
    })

    it('has a number that reads TR-0001 and is not repeated inside the organization', async () => {
      for (const number of ['TR-1', 'tr-0001', 'TR-00a1', 'X-0001', '']) {
        await refused(
          owner.stockTransfer.create({ data: header({ number }) }),
          /chk_stock_transfers_number/
        )
      }
      const first = await owner.stockTransfer.create({ data: header() })
      await refused(
        owner.stockTransfer.create({ data: header({ number: first.number }) }),
        /stock_transfers_organization_id_number_key/
      )
    })

    it('is in a status that exists, and the dates agree with it', async () => {
      await refused(
        owner.stockTransfer.create({ data: header({ status: 'lost' }) }),
        /chk_stock_transfers_status/
      )
      // A draft has not left; one in transit has; one that ended has the moment it ended
      await refused(
        owner.stockTransfer.create({
          data: header({ status: 'draft', dispatchedAt: new Date(), dispatchedBy: 'x' })
        }),
        /chk_stock_transfers_dispatch/
      )
      await refused(
        owner.stockTransfer.create({ data: header({ status: 'in_transit' }) }),
        /chk_stock_transfers_dispatch/
      )
      await refused(
        owner.stockTransfer.create({
          data: header({ status: 'received', dispatchedAt: new Date(), dispatchedBy: 'x' })
        }),
        /chk_stock_transfers_closed/
      )
      await refused(
        owner.stockTransfer.create({ data: header({ status: 'cancelled' }) }),
        /chk_stock_transfers_closed/
      )
      await owner.stockTransfer.create({
        data: header({ status: 'cancelled', closedAt: new Date() })
      })
    })
  })

  describe('a line', () => {
    const line = (transferId: string, productId: string, extra: Record<string, unknown> = {}) => ({
      transferId,
      storeId: ctx.storeA.id,
      productId,
      quantity: 5,
      ...extra
    })

    it('names a product of its store: the product of another store is refused', async () => {
      const transfer = await createTransfer(owner, { organizationId: ctx.orgA.id })
      const foreign = await createProduct(owner, { storeId: ctx.storeB.id })
      await refused(
        owner.stockTransferLine.create({ data: line(transfer.id, foreign.id) }),
        /stock_transfer_lines_store_id_product_id_fkey/
      )
    })

    it('names a store of the organization of the transfer, whatever the application does', async () => {
      const transfer = await createTransfer(owner, { organizationId: ctx.orgA.id })
      const foreign = await createProduct(owner, { storeId: ctx.storeB.id })
      await refused(
        owner.stockTransferLine.create({
          data: line(transfer.id, foreign.id, { storeId: ctx.storeB.id })
        }),
        /is not a store of the organization of the transfer/
      )
      // And a transfer of organization B takes no line of a store of organization A
      const theirs = await createTransfer(owner, { organizationId: ctx.orgB.id })
      const mine = await createProduct(owner, { storeId: ctx.storeA.id })
      await refused(
        owner.stockTransferLine.create({ data: line(theirs.id, mine.id) }),
        /is not a store of the organization of the transfer/
      )
    })

    it('names a variant of its product, never one of another product', async () => {
      const transfer = await createTransfer(owner, { organizationId: ctx.orgA.id })
      const product = await createProduct(owner, { storeId: ctx.storeA.id })
      const other = await createProduct(owner, { storeId: ctx.storeA.id })
      const variantOfOther = await createProductVariant(owner, { productId: other.id })
      await refused(
        owner.stockTransferLine.create({
          data: line(transfer.id, product.id, { variantId: variantOfOther.id })
        }),
        /is not a variant of its product/
      )
    })

    it('holds a whole number of units, never more received than sent, and a shortage action that exists', async () => {
      const transfer = await createTransfer(owner, { organizationId: ctx.orgA.id })
      const product = await createProduct(owner, { storeId: ctx.storeA.id })
      for (const quantity of [0, -1]) {
        await refused(
          owner.stockTransferLine.create({ data: line(transfer.id, product.id, { quantity }) }),
          /chk_stock_transfer_lines_quantity/
        )
      }
      await refused(
        owner.stockTransferLine.create({
          data: line(transfer.id, product.id, { quantity: 5, receivedQuantity: 6 })
        }),
        /chk_stock_transfer_lines_received/
      )
      await refused(
        owner.stockTransferLine.create({
          data: line(transfer.id, product.id, { receivedQuantity: -1 })
        }),
        /chk_stock_transfer_lines_received/
      )
      await refused(
        owner.stockTransferLine.create({
          data: line(transfer.id, product.id, { shortageAction: 'forget_it' })
        }),
        /chk_stock_transfer_lines_shortage_action/
      )
    })

    it('is one per item in a transfer, with or without a variant', async () => {
      const transfer = await createTransfer(owner, { organizationId: ctx.orgA.id })
      const product = await createProduct(owner, { storeId: ctx.storeA.id })
      const variant = await createProductVariant(owner, { productId: product.id })
      await owner.stockTransferLine.create({ data: line(transfer.id, product.id) })
      await refused(
        owner.stockTransferLine.create({ data: line(transfer.id, product.id) }),
        /uq_stock_transfer_lines_product/
      )
      await owner.stockTransferLine.create({
        data: line(transfer.id, product.id, { variantId: variant.id })
      })
      await refused(
        owner.stockTransferLine.create({
          data: line(transfer.id, product.id, { variantId: variant.id })
        }),
        /uq_stock_transfer_lines_variant/
      )
    })

    it('stops a product, a store or a warehouse with transfer lines from being deleted', async () => {
      const transfer = await createTransfer(owner, {
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id
      })
      const row = await owner.stockTransferLine.findFirstOrThrow({
        where: { transferId: transfer.id }
      })
      await refused(
        owner.product.delete({ where: { id: row.productId } }),
        /Foreign key constraint violated/
      )
      await refused(
        owner.store.delete({ where: { id: ctx.storeA.id } }),
        /Foreign key constraint violated/
      )
      const header = await owner.stockTransfer.findUniqueOrThrow({ where: { id: transfer.id } })
      await refused(
        owner.warehouse.delete({ where: { id: header.fromWarehouseId } }),
        /Foreign key constraint violated/
      )
      const spare = await createWarehouse(owner, { organizationId: ctx.orgA.id })
      await owner.warehouse.delete({ where: { id: spare.id } })
    })
  })
})
