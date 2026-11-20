import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import supertest from 'supertest'

import { API_PREFIX, PluginApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { PrismaService, RLS_CONTEXT_ENABLED } from '@platform/core/database'
import { connectionUrls, type OwnerClient } from '@platform/core/database-testing'
import {
  InventoryReferenceType,
  TransferShortageAction,
  TransferStatus
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { PluginScopes } from '@platform/plugins/sdk'

import {
  createInventoryLevel,
  createPluginKey,
  createProduct,
  createWarehouse,
  linkWarehouse,
  uniqueTransferNumber
} from '../builders'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'

interface ErrorBody {
  error: { code: string }
}

const OK = 200
const NOT_FOUND = 404
const CONFLICT = 409
const STOCK = 10
const QUANTITY = 4

// RLS phase 6, the write routes of a plugin. The key of a plugin is bound to ONE store, and with the switch ON the context of its
// request holds that store alone. A transfer that also carries a line of a sibling store of the organization shows the plugin only
// its own lines, so "the transfer holds only lines of my store" was decided on what was left: a dispatch went through for the
// store of the key and skipped the sibling's units, and a receipt, a close or a cancel decided for lines it could not see. The
// context of a plugin is not widened (a key is bound to one store); the stores of the lines of the transfer are asked of the database
// by a function that answers with ids alone, and the write is refused before it moves anything. The app below is the real one, on
// the role of the api, with the switch on and a context required for every query.
describe('RLS phase 6: a plugin writes only a transfer whose every line is of the store of its key', () => {
  const prefix = newRunPrefix()
  const pluginId = `${prefix}-rls-transfers`
  const otherPluginId = `${prefix}-rls-transfers-b`
  let app: INestApplication
  let guarded: PrismaService
  let owner: OwnerClient
  let ctx: TestContext
  let key = ''
  let keyOfB = ''
  let destination: { id: string }

  beforeAll(async () => {
    owner = ownerClient()
    guarded = new PrismaService({
      databaseUrl: connectionUrls().app,
      poolSize: 8,
      requireContext: true
    })
    app = await createTestApp([], builder =>
      builder
        .overrideProvider(PrismaService)
        .useValue(guarded)
        .overrideProvider(RLS_CONTEXT_ENABLED)
        .useValue(true)
    )
    ctx = await seedTestContext(owner, app, prefix)
    destination = await createWarehouse(owner, { organizationId: ctx.orgA.id, name: 'Destination' })
    for (const storeId of [ctx.storeA.id, ctx.storeA2.id]) {
      await linkWarehouse(owner, {
        organizationId: ctx.orgA.id,
        storeId,
        warehouseId: destination.id
      })
    }
    const scopes = [
      PluginScopes.TRANSFERS_READ,
      PluginScopes.TRANSFERS_WRITE,
      PluginScopes.TRANSFERS_RECEIVE
    ]
    ;({ key } = await createPluginKey(owner, { storeId: ctx.storeA.id, pluginId, scopes }))
    ;({ key: keyOfB } = await createPluginKey(owner, {
      storeId: ctx.storeB.id,
      pluginId: otherPluginId,
      scopes
    }))
  })
  afterAll(async () => {
    await owner.pluginInstallation.deleteMany({ where: { pluginId: { startsWith: pluginId } } })
    await owner.plugin.deleteMany({ where: { id: { startsWith: pluginId } } })
    await cleanUp(owner, prefix)
    await app.close()
    await guarded.onModuleDestroy()
    await owner.$disconnect()
  })

  const call = (method: 'get' | 'post' | 'patch', path: string, withKey = key) =>
    supertest(app.getHttpServer() as Parameters<typeof supertest>[0])
      [method](`${API_PREFIX}${path}`)
      .set('authorization', `Bearer ${withKey}`)
  const codeOf = (response: { body: unknown }) => (response.body as ErrorBody).error.code

  // A product of the store with STOCK units in the warehouse given, written as the owner (the fixture is not what is under test)
  async function stocked(storeId: string) {
    const product = await createProduct(owner, { storeId })
    await createInventoryLevel(owner, {
      storeId,
      productId: product.id,
      warehouseId: ctx.warehouseA.id,
      onHand: STOCK
    })
    return { storeId, productId: product.id }
  }
  const onHand = async (item: { storeId: string; productId: string }): Promise<number> =>
    (
      await owner.inventoryLevel.findFirst({
        where: { ...item, warehouseId: ctx.warehouseA.id }
      })
    )?.onHand ?? 0

  // A transfer of the organization written as the owner, with one line of store A and (when asked) one of store A2
  async function transfer(options: { sibling: boolean; status?: TransferStatus }) {
    const mine = await stocked(ctx.storeA.id)
    const theirs = options.sibling ? await stocked(ctx.storeA2.id) : null
    const status = options.status ?? TransferStatus.DRAFT
    const made = await owner.stockTransfer.create({
      data: {
        organizationId: ctx.orgA.id,
        number: uniqueTransferNumber(),
        fromWarehouseId: ctx.warehouseA.id,
        toWarehouseId: destination.id,
        status,
        createdBy: ctx.adminA.id,
        ...(status === TransferStatus.DRAFT
          ? {}
          : { dispatchedAt: new Date(), dispatchedBy: ctx.adminA.id }),
        lines: {
          create: [mine, ...(theirs === null ? [] : [theirs])].map(item => ({
            storeId: item.storeId,
            productId: item.productId,
            quantity: QUANTITY
          }))
        }
      },
      select: { id: true, lines: { select: { id: true, storeId: true } } }
    })
    return { mine, theirs, made }
  }

  async function expectNothingMoved(
    id: string,
    status: TransferStatus,
    items: Parameters<typeof onHand>[0][]
  ) {
    for (const item of items) expect(await onHand(item)).toBe(STOCK)
    expect((await owner.stockTransfer.findUniqueOrThrow({ where: { id } })).status).toBe(status)
    expect(
      await owner.inventoryMovement.count({
        where: { referenceType: InventoryReferenceType.TRANSFER, referenceId: id }
      })
    ).toBe(0)
    expect(await owner.auditLog.count({ where: { resourceId: id } })).toBe(0)
  }

  describe('a transfer of the store of the key and a sibling store', () => {
    it('is not dispatched: the units of neither store leave', async () => {
      const { mine, theirs, made } = await transfer({ sibling: true })

      const response = await call('post', PluginApiRoutes.transfers.dispatch(made.id)).send({})

      expect(response.status).toBe(CONFLICT)
      expect(codeOf(response)).toBe(ErrorCodes.INVENTORY_TRANSFER_LINES_OUT_OF_REACH)
      await expectNothingMoved(made.id, TransferStatus.DRAFT, [mine, theirs ?? mine])
    })

    it('is not changed', async () => {
      const { mine, made } = await transfer({ sibling: true })

      const response = await call('patch', PluginApiRoutes.transfers.byId(made.id)).send({
        note: 'mine now'
      })

      expect(response.status).toBe(CONFLICT)
      expect(codeOf(response)).toBe(ErrorCodes.INVENTORY_TRANSFER_LINES_OUT_OF_REACH)
      expect((await owner.stockTransfer.findUniqueOrThrow({ where: { id: made.id } })).note).toBe(
        null
      )
      expect(await onHand(mine)).toBe(STOCK)
    })

    it('is not cancelled', async () => {
      const { mine, theirs, made } = await transfer({ sibling: true })

      const response = await call('post', PluginApiRoutes.transfers.cancel(made.id)).send({})

      expect(response.status).toBe(CONFLICT)
      expect(codeOf(response)).toBe(ErrorCodes.INVENTORY_TRANSFER_LINES_OUT_OF_REACH)
      await expectNothingMoved(made.id, TransferStatus.DRAFT, [mine, theirs ?? mine])
    })

    it('is not received', async () => {
      const { made } = await transfer({ sibling: true, status: TransferStatus.IN_TRANSIT })
      const own = made.lines.find(line => line.storeId === ctx.storeA.id)

      const response = await call('post', PluginApiRoutes.transfers.receive(made.id)).send({
        receiptKey: randomUUID(),
        lines: [{ lineId: own?.id, quantity: QUANTITY }]
      })

      expect(response.status).toBe(CONFLICT)
      expect(codeOf(response)).toBe(ErrorCodes.INVENTORY_TRANSFER_LINES_OUT_OF_REACH)
      expect((await owner.stockTransfer.findUniqueOrThrow({ where: { id: made.id } })).status).toBe(
        TransferStatus.IN_TRANSIT
      )
      expect(
        await owner.inventoryMovement.count({
          where: { referenceType: InventoryReferenceType.TRANSFER, referenceId: made.id }
        })
      ).toBe(0)
    })

    it('is not closed', async () => {
      const { made } = await transfer({ sibling: true, status: TransferStatus.IN_TRANSIT })
      const own = made.lines.find(line => line.storeId === ctx.storeA.id)

      const response = await call('post', PluginApiRoutes.transfers.close(made.id)).send({
        lines: [{ lineId: own?.id, action: TransferShortageAction.RETURN_TO_SOURCE }]
      })

      expect(response.status).toBe(CONFLICT)
      expect(codeOf(response)).toBe(ErrorCodes.INVENTORY_TRANSFER_LINES_OUT_OF_REACH)
      expect((await owner.stockTransfer.findUniqueOrThrow({ where: { id: made.id } })).status).toBe(
        TransferStatus.IN_TRANSIT
      )
    })
  })

  describe('a transfer of the store of the key alone', () => {
    it('is dispatched as before: the units leave and the movement names the plugin', async () => {
      const { mine, made } = await transfer({ sibling: false })

      const response = await call('post', PluginApiRoutes.transfers.dispatch(made.id)).send({})

      expect(response.status).toBe(OK)
      expect(await onHand(mine)).toBe(STOCK - QUANTITY)
      const movements = await owner.inventoryMovement.findMany({
        where: { referenceType: InventoryReferenceType.TRANSFER, referenceId: made.id }
      })
      expect(movements).toHaveLength(1)
      expect(movements[0]?.createdByPluginId).toBe(pluginId)
      const entries = await waitForAuditEntries(owner, {
        action: AuditAction.TRANSFER_DISPATCHED,
        resourceId: made.id
      })
      expect(entries).toHaveLength(1)
    })
  })

  describe('a transfer of another organization', () => {
    it('does not exist for the plugin of that organization: 404, the same as an unknown id', async () => {
      const { made } = await transfer({ sibling: true })

      const foreign = await call('post', PluginApiRoutes.transfers.dispatch(made.id), keyOfB).send(
        {}
      )
      const unknown = await call(
        'post',
        PluginApiRoutes.transfers.dispatch(randomUUID()),
        keyOfB
      ).send({})

      expect(foreign.status).toBe(NOT_FOUND)
      expect(unknown.status).toBe(NOT_FOUND)
      expect(codeOf(foreign)).toBe(codeOf(unknown))
    })
  })

  describe('the function that tells the stores of the lines', () => {
    const storesOf = (transferId: string, organizationId: string, storeId: string) =>
      guarded.tenantTransaction(
        { storeIds: [storeId], organizationIds: [organizationId] },
        () =>
          guarded.client.$queryRaw<
            { stores: string[] | null }[]
          >`SELECT rls_transfer_line_store_ids(${transferId}) AS stores`
      )

    it('answers with the stores of every line of a transfer of the organization of the context', async () => {
      const { made } = await transfer({ sibling: true })

      const rows = await storesOf(made.id, ctx.orgA.id, ctx.storeA.id)

      expect([...(rows[0]?.stores ?? [])].sort()).toEqual([ctx.storeA.id, ctx.storeA2.id].sort())
    })

    it('answers with nothing for a transfer of another organization, and with an empty list for one with no line', async () => {
      const { made } = await transfer({ sibling: true })
      const empty = await owner.stockTransfer.create({
        data: {
          organizationId: ctx.orgA.id,
          number: uniqueTransferNumber(),
          fromWarehouseId: ctx.warehouseA.id,
          toWarehouseId: destination.id,
          createdBy: ctx.adminA.id
        },
        select: { id: true }
      })

      const foreign = await storesOf(made.id, ctx.orgB.id, ctx.storeB.id)
      const none = await storesOf(empty.id, ctx.orgA.id, ctx.storeA.id)

      expect(foreign[0]?.stores).toBeNull()
      expect(none[0]?.stores).toEqual([])
    })
  })
})
