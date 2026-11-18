import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import supertest from 'supertest'

import { API_PREFIX, PluginApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  CountStatus,
  InventoryAdjustmentReason,
  InventoryReferenceType,
  TransferShortageAction,
  TransferStatus,
  InventoryMovementType as Type
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { InventoryService } from '@platform/core/inventory'
import { PluginScopes } from '@platform/plugins/sdk'

import { createPluginKey, createProduct, createWarehouse, linkWarehouse } from '../builders'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'

interface ErrorBody {
  error: { code: string }
}
interface LineBody {
  id: string
  quantity: number
  receivedQuantity: number
}
interface TransferBody {
  id: string
  status: string
  lines: LineBody[]
}
interface CountBody {
  id: string
  status: string
  storeId: string | null
}

const OK = 200
const CREATED = 201
const FORBIDDEN = 403
const NOT_FOUND = 404
const CONFLICT = 409

// What a plugin writes of the transfers and the counts (Step 5.6 PR E4b-2): the same services as the screens, so the rules of
// the stock are theirs; what changes is who is named. The movements, the transfer, the count and the audit entry hold the plugin
// (never a user), and the answer names no one.
describe('Transfers and counts written with the key of a plugin', () => {
  const prefix = newRunPrefix()
  const pluginId = `${prefix}-stock-write`
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let inventory: InventoryService
  let key = ''
  let installationId = ''
  let otherWarehouse: { id: string }

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    inventory = app.get(InventoryService)
    otherWarehouse = await createWarehouse(owner, { organizationId: ctx.orgA.id, name: 'Second' })
    await linkWarehouse(owner, {
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA.id,
      warehouseId: otherWarehouse.id
    })
    ;({ key, installationId } = await createPluginKey(owner, {
      storeId: ctx.storeA.id,
      pluginId,
      scopes: [
        PluginScopes.TRANSFERS_READ,
        PluginScopes.TRANSFERS_WRITE,
        PluginScopes.TRANSFERS_RECEIVE,
        PluginScopes.COUNTS_READ,
        PluginScopes.COUNTS_WRITE,
        PluginScopes.COUNTS_APPLY
      ]
    }))
  })
  afterAll(async () => {
    await owner.pluginInstallation.deleteMany({ where: { pluginId: { startsWith: pluginId } } })
    await owner.plugin.deleteMany({ where: { id: { startsWith: pluginId } } })
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const call = (method: 'get' | 'post' | 'patch', path: string, withKey = key) =>
    supertest(app.getHttpServer() as Parameters<typeof supertest>[0])
      [method](`${API_PREFIX}${path}`)
      .set('authorization', `Bearer ${withKey}`)
  const codeOf = (response: { body: unknown }) => (response.body as ErrorBody).error.code

  async function stocked(quantity: number, warehouseId = ctx.warehouseA.id) {
    const product = await createProduct(owner, { storeId: ctx.storeA.id })
    await inventory.move({
      storeId: ctx.storeA.id,
      productId: product.id,
      warehouseId,
      type: Type.RECEIPT,
      quantity,
      reason: InventoryAdjustmentReason.OPENING_STOCK,
      idempotencyKey: randomUUID()
    })
    return product.id
  }
  const onHand = async (productId: string, warehouseId: string): Promise<number> =>
    (
      await owner.inventoryLevel.findFirst({
        where: { storeId: ctx.storeA.id, productId, warehouseId }
      })
    )?.onHand ?? 0

  async function draft(productId: string, quantity: number): Promise<TransferBody> {
    const response = await call('post', PluginApiRoutes.transfers.create).send({
      fromWarehouseId: ctx.warehouseA.id,
      toWarehouseId: otherWarehouse.id,
      lines: [{ productId, quantity }]
    })
    expect(response.status).toBe(CREATED)
    return response.body as TransferBody
  }

  // Dispatch, receipt, the units a close sends back and the ones a cancel returns are separate paths of the service: each movement
  // they write names the plugin and no person
  async function expectEveryMovementOfThePlugin(transferId: string): Promise<void> {
    const movements = await owner.inventoryMovement.findMany({
      where: { referenceType: InventoryReferenceType.TRANSFER, referenceId: transferId }
    })
    expect(movements.length).toBeGreaterThan(1)
    for (const movement of movements) {
      expect([movement.createdBy, movement.createdByPluginId]).toEqual([null, pluginId])
    }
  }

  describe('transfers', () => {
    it('makes, sends and receives a transfer: the stock moves by the rules of the screen and the plugin is the author', async () => {
      const productId = await stocked(10)
      const made = await draft(productId, 4)
      const [line] = made.lines
      expect(line).toBeDefined()

      const row = await owner.stockTransfer.findUniqueOrThrow({ where: { id: made.id } })
      expect(row.createdBy).toBeNull()
      expect(row.createdByPluginId).toBe(pluginId)
      // The answer names nobody
      expect(JSON.stringify(made)).not.toMatch(/createdBy|dispatchedBy|PluginId/)

      const sent = await call('post', PluginApiRoutes.transfers.dispatch(made.id)).send({})
      expect(sent.status).toBe(OK)
      expect(await onHand(productId, ctx.warehouseA.id)).toBe(6)
      const dispatched = await owner.stockTransfer.findUniqueOrThrow({ where: { id: made.id } })
      expect(dispatched.dispatchedBy).toBeNull()
      expect(dispatched.dispatchedByPluginId).toBe(pluginId)
      const movements = await owner.inventoryMovement.findMany({
        where: { referenceType: InventoryReferenceType.TRANSFER, referenceId: made.id }
      })
      expect(movements).toHaveLength(1)
      expect(movements[0]?.createdBy).toBeNull()
      expect(movements[0]?.createdByPluginId).toBe(pluginId)

      const received = await call('post', PluginApiRoutes.transfers.receive(made.id)).send({
        receiptKey: randomUUID(),
        lines: [{ lineId: line?.id, quantity: 4 }]
      })
      expect(received.status).toBe(OK)
      expect((received.body as TransferBody).status).toBe(TransferStatus.RECEIVED)
      expect(await onHand(productId, otherWarehouse.id)).toBe(4)
      const arrivals = await owner.inventoryMovement.findMany({
        where: {
          referenceType: InventoryReferenceType.TRANSFER,
          referenceId: made.id,
          type: Type.TRANSFER_IN
        }
      })
      expect(arrivals.every(arrival => arrival.createdByPluginId === pluginId)).toBe(true)

      const entries = await waitForAuditEntries(owner, {
        action: AuditAction.TRANSFER_DISPATCHED,
        resourceId: made.id
      })
      expect(entries[0]?.userId).toBeNull()
      expect(entries[0]?.metadata).toMatchObject({ pluginInstallationId: installationId })
    })

    it('refuses to send more than is on the shelf, as for a person, and writes nothing', async () => {
      const productId = await stocked(2)
      const made = await draft(productId, 5)

      const sent = await call('post', PluginApiRoutes.transfers.dispatch(made.id)).send({})

      expect(sent.status).toBe(CONFLICT)
      expect(await onHand(productId, ctx.warehouseA.id)).toBe(2)
      expect(await transferStatus(made.id)).toBe(TransferStatus.DRAFT)
    })

    it('changes a draft, and cancels one in transit: the units go back to the source', async () => {
      const productId = await stocked(8)
      const made = await draft(productId, 3)

      const changed = await call('patch', PluginApiRoutes.transfers.byId(made.id)).send({
        note: 'changed',
        lines: [{ productId, quantity: 5 }]
      })
      expect(changed.status).toBe(OK)
      expect((changed.body as TransferBody).lines[0]?.quantity).toBe(5)

      await call('post', PluginApiRoutes.transfers.dispatch(made.id)).send({})
      expect(await onHand(productId, ctx.warehouseA.id)).toBe(3)
      const cancelled = await call('post', PluginApiRoutes.transfers.cancel(made.id)).send({})
      expect(cancelled.status).toBe(OK)
      expect(await onHand(productId, ctx.warehouseA.id)).toBe(8)
      expect(await transferStatus(made.id)).toBe(TransferStatus.CANCELLED)
      await expectEveryMovementOfThePlugin(made.id)
    })

    it('closes a transfer with a shortage, and answers the same receipt key the same way', async () => {
      const productId = await stocked(6)
      const made = await draft(productId, 6)
      await call('post', PluginApiRoutes.transfers.dispatch(made.id)).send({})
      const [line] = made.lines
      const receiptKey = randomUUID()
      const body = { receiptKey, lines: [{ lineId: line?.id, quantity: 2 }] }

      const first = await call('post', PluginApiRoutes.transfers.receive(made.id)).send(body)
      const again = await call('post', PluginApiRoutes.transfers.receive(made.id)).send(body)
      const closed = await call('post', PluginApiRoutes.transfers.close(made.id)).send({
        lines: [{ lineId: line?.id, action: TransferShortageAction.RETURN_TO_SOURCE }]
      })

      expect([first.status, again.status, closed.status]).toEqual([OK, OK, OK])
      expect(await onHand(productId, otherWarehouse.id)).toBe(2)
      expect(await onHand(productId, ctx.warehouseA.id)).toBe(4)
      await expectEveryMovementOfThePlugin(made.id)
    })

    it('does not write a transfer that holds a line of a sibling store, and says so (409)', async () => {
      const productId = await stocked(5)
      const made = await draft(productId, 1)
      const sibling = await createProduct(owner, { storeId: ctx.storeA2.id })
      await owner.stockTransferLine.create({
        data: { transferId: made.id, storeId: ctx.storeA2.id, productId: sibling.id, quantity: 1 }
      })

      const sent = await call('post', PluginApiRoutes.transfers.dispatch(made.id)).send({})

      expect(sent.status).toBe(CONFLICT)
      expect(codeOf(sent)).toBe(ErrorCodes.INVENTORY_TRANSFER_LINES_OUT_OF_REACH)
      expect(await onHand(productId, ctx.warehouseA.id)).toBe(5)
    })

    it('never makes a transfer of no line: the plugin could not read it', async () => {
      const response = await call('post', PluginApiRoutes.transfers.create).send({
        fromWarehouseId: ctx.warehouseA.id,
        toWarehouseId: otherWarehouse.id,
        lines: []
      })

      expect(response.status).toBe(400)
    })

    const transferStatus = async (id: string) =>
      (await owner.stockTransfer.findUniqueOrThrow({ where: { id } })).status
  })

  describe('counts', () => {
    it('opens a count limited to its store, counts, submits and applies it: the variance moves the stock, the plugin is the author', async () => {
      const productId = await stocked(10)
      const created = await call('post', PluginApiRoutes.counts.create).send({
        warehouseId: ctx.warehouseA.id
      })
      expect(created.status).toBe(CREATED)
      const count = created.body as CountBody
      // Limited to the store of the key whatever the body said
      expect(count.storeId).toBe(ctx.storeA.id)
      const row = await owner.stockCount.findUniqueOrThrow({ where: { id: count.id } })
      expect(row.createdBy).toBeNull()
      expect(row.createdByPluginId).toBe(pluginId)
      expect(JSON.stringify(created.body)).not.toMatch(/createdBy|appliedBy|PluginId/)

      expect((await call('post', PluginApiRoutes.counts.start(count.id)).send({})).status).toBe(OK)
      const detail = await call('get', PluginApiRoutes.counts.byId(count.id))
      const line = (detail.body as { lines: { id: string; productId: string }[] }).lines.find(
        candidate => candidate.productId === productId
      )
      expect(line).toBeDefined()
      const counted = await call('patch', PluginApiRoutes.counts.lines(count.id)).send({
        lines: [{ lineId: line?.id, countedQuantity: 7 }]
      })
      expect(counted.status).toBe(OK)
      expect((await call('post', PluginApiRoutes.counts.submit(count.id)).send({})).status).toBe(OK)
      const applied = await call('post', PluginApiRoutes.counts.apply(count.id)).send({})

      expect(applied.status).toBe(OK)
      expect((applied.body as CountBody).status).toBe(CountStatus.APPLIED)
      expect(await onHand(productId, ctx.warehouseA.id)).toBe(7)
      const after = await owner.stockCount.findUniqueOrThrow({ where: { id: count.id } })
      expect(after.appliedBy).toBeNull()
      expect(after.appliedByPluginId).toBe(pluginId)
      const movements = await owner.inventoryMovement.findMany({
        where: { referenceType: InventoryReferenceType.COUNT, referenceId: count.id }
      })
      expect(movements).toHaveLength(1)
      expect(movements[0]?.createdBy).toBeNull()
      expect(movements[0]?.createdByPluginId).toBe(pluginId)
      const entries = await waitForAuditEntries(owner, {
        action: AuditAction.COUNT_APPLIED,
        resourceId: count.id
      })
      expect(entries[0]?.userId).toBeNull()
      expect(entries[0]?.metadata).toMatchObject({ pluginInstallationId: installationId })
    })

    it('reopens a count in review and cancels one, as a person with the permission may', async () => {
      await stocked(3)
      const created = await call('post', PluginApiRoutes.counts.create).send({
        warehouseId: ctx.warehouseA.id
      })
      const id = (created.body as CountBody).id
      await call('post', PluginApiRoutes.counts.start(id)).send({})
      await call('post', PluginApiRoutes.counts.submit(id)).send({})

      const reopened = await call('post', PluginApiRoutes.counts.reopen(id)).send({})
      const cancelled = await call('post', PluginApiRoutes.counts.cancel(id)).send({})

      expect((reopened.body as CountBody).status).toBe(CountStatus.COUNTING)
      expect((cancelled.body as CountBody).status).toBe(CountStatus.CANCELLED)
    })

    it('does not open a count of a warehouse its store keeps no stock in', async () => {
      const unlinked = await createWarehouse(owner, { organizationId: ctx.orgA.id })

      const response = await call('post', PluginApiRoutes.counts.create).send({
        warehouseId: unlinked.id
      })

      expect(response.status).toBe(NOT_FOUND)
    })

    it('refuses to apply a count that would take the stock below zero, as for a person, and keeps it in review', async () => {
      const productId = await stocked(4)
      const created = await call('post', PluginApiRoutes.counts.create).send({
        warehouseId: ctx.warehouseA.id
      })
      const id = (created.body as CountBody).id
      await call('post', PluginApiRoutes.counts.start(id)).send({})
      const detail = await call('get', PluginApiRoutes.counts.byId(id))
      const line = (detail.body as { lines: { id: string; productId: string }[] }).lines.find(
        candidate => candidate.productId === productId
      )
      await call('patch', PluginApiRoutes.counts.lines(id)).send({
        lines: [{ lineId: line?.id, countedQuantity: 0 }]
      })
      await call('post', PluginApiRoutes.counts.submit(id)).send({})
      // The shelf emptied while the sheet was open: the variance (-4) can no longer be written
      await inventory.move({
        storeId: ctx.storeA.id,
        productId,
        warehouseId: ctx.warehouseA.id,
        type: Type.ADJUSTMENT_OUT,
        quantity: 4,
        reason: InventoryAdjustmentReason.DAMAGED,
        idempotencyKey: randomUUID()
      })

      const applied = await call('post', PluginApiRoutes.counts.apply(id)).send({})

      expect(applied.status).toBe(CONFLICT)
      expect(codeOf(applied)).toBe(ErrorCodes.INSUFFICIENT_INVENTORY)
      expect((await owner.stockCount.findUniqueOrThrow({ where: { id } })).status).toBe(
        CountStatus.REVIEW
      )
    })
  })

  // `transfers:read` and `counts:read` stand for the permissions of writing too (who reads a transfer is who may send or receive
  // it), and a write route names its own scope and the read one: the permissions of a request are those of the scopes of the ROUTE,
  // so a key that reads, or that writes one step, is not lent the permission of another step. Every write route is tried with
  // every key that lacks one of its scopes: it must be refused for the scope, and nothing may change.
  describe('a scope does not lend the permission of another', () => {
    const S = PluginScopes
    const keyScopes: Record<string, string[]> = {
      't-read': [S.TRANSFERS_READ],
      't-write': [S.TRANSFERS_READ, S.TRANSFERS_WRITE],
      't-receive': [S.TRANSFERS_READ, S.TRANSFERS_RECEIVE],
      't-write-only': [S.TRANSFERS_WRITE],
      'c-read': [S.COUNTS_READ],
      'c-write': [S.COUNTS_READ, S.COUNTS_WRITE],
      'c-apply': [S.COUNTS_READ, S.COUNTS_APPLY],
      'c-write-only': [S.COUNTS_WRITE]
    }
    const keys: Record<string, string> = {}
    beforeAll(async () => {
      for (const [name, scopes] of Object.entries(keyScopes)) {
        keys[name] = (
          await createPluginKey(owner, {
            storeId: ctx.storeA.id,
            pluginId: `${pluginId}-${name}`,
            scopes
          })
        ).key
      }
    })

    it('refuses every write route to a key that lacks a scope of the route, for the scope, and changes nothing', async () => {
      const transfer = await draft(await stocked(10), 3)
      const created = await call('post', PluginApiRoutes.counts.create).send({
        warehouseId: ctx.warehouseA.id
      })
      expect(created.status).toBe(CREATED)
      const count = created.body as CountBody
      const T = PluginApiRoutes.transfers
      const C = PluginApiRoutes.counts
      const routes: { method: 'post' | 'patch'; path: string; needs: string[] }[] = [
        { method: 'post', path: T.create, needs: [S.TRANSFERS_WRITE, S.TRANSFERS_READ] },
        {
          method: 'patch',
          path: T.byId(transfer.id),
          needs: [S.TRANSFERS_WRITE, S.TRANSFERS_READ]
        },
        {
          method: 'post',
          path: T.dispatch(transfer.id),
          needs: [S.TRANSFERS_WRITE, S.TRANSFERS_READ]
        },
        {
          method: 'post',
          path: T.cancel(transfer.id),
          needs: [S.TRANSFERS_WRITE, S.TRANSFERS_READ]
        },
        {
          method: 'post',
          path: T.receive(transfer.id),
          needs: [S.TRANSFERS_RECEIVE, S.TRANSFERS_READ]
        },
        {
          method: 'post',
          path: T.close(transfer.id),
          needs: [S.TRANSFERS_RECEIVE, S.TRANSFERS_READ]
        },
        { method: 'post', path: C.create, needs: [S.COUNTS_WRITE, S.COUNTS_READ] },
        { method: 'post', path: C.start(count.id), needs: [S.COUNTS_WRITE, S.COUNTS_READ] },
        { method: 'patch', path: C.lines(count.id), needs: [S.COUNTS_WRITE, S.COUNTS_READ] },
        { method: 'post', path: C.submit(count.id), needs: [S.COUNTS_WRITE, S.COUNTS_READ] },
        { method: 'post', path: C.reopen(count.id), needs: [S.COUNTS_WRITE, S.COUNTS_READ] },
        { method: 'post', path: C.cancel(count.id), needs: [S.COUNTS_WRITE, S.COUNTS_READ] },
        { method: 'post', path: C.apply(count.id), needs: [S.COUNTS_APPLY, S.COUNTS_READ] }
      ]
      const wrong: string[] = []
      let tried = 0
      for (const [name, scopes] of Object.entries(keyScopes)) {
        for (const route of routes) {
          // A key that holds every scope of the route would write: those are the cases of the tests above
          if (route.needs.every(scope => scopes.includes(scope))) continue
          tried += 1
          const response = await call(route.method, route.path, keys[name]).send({})
          if (
            response.status !== FORBIDDEN ||
            codeOf(response) !== ErrorCodes.PLUGIN_SCOPE_DENIED
          ) {
            wrong.push(`${name} ${route.method} ${route.path}: ${response.status}`)
          }
        }
      }
      expect(tried).toBeGreaterThan(50)
      expect(wrong).toEqual([])
      expect(
        (await owner.stockTransfer.findUniqueOrThrow({ where: { id: transfer.id } })).status
      ).toBe(TransferStatus.DRAFT)
      expect((await owner.stockCount.findUniqueOrThrow({ where: { id: count.id } })).status).toBe(
        CountStatus.DRAFT
      )
    })
  })
})
