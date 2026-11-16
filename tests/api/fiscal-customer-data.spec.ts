import type { INestApplication } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { type Permission, Permissions } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import { FiscalEnvironment, FiscalIssueOn, OrderStatus } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { Events } from '@platform/core/events'
import { SIMULATOR_PROVIDER_ID, SimulatorRules } from '@platform/fiscal/simulator'

import { createCustomer, createCustomerFiscalData, createOrder } from '../builders'
import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

const OK = 200
const NO_CONTENT = 204
const BAD_REQUEST = 400
const FORBIDDEN = 403
const NOT_FOUND = 404
const CONFLICT = 409

const TAX_ID = 'ZQ-TAX-4455667'
const REGISTRATION = 'ZQ-REG-889900'
const ACTIVITY = 'Retail of zq goods'
const ADDRESS = { line1: 'Zq Street 12', city: 'Zq City' }

describe('The fiscal data of a customer (Step 4B.7b-3)', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let emitter: EventEmitter2

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    emitter = app.get(EventEmitter2)
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const asAdminA = () => api(app, ctx.adminA, ctx.storeA)
  const asAdminB = () => api(app, ctx.adminB, ctx.storeB)
  const customerA = async () => (await createCustomer(owner, { storeId: ctx.storeA.id })).id
  const put = (customerId: string, body: Record<string, unknown>) =>
    asAdminA().put(ApiRoutes.fiscal.customerData.put(customerId)).send(body)
  const get = (customerId: string) => asAdminA().get(ApiRoutes.fiscal.customerData.get(customerId))

  // A delivered order of the customer, with the tax snapshot of Step 4B.3b, and its sale event: the listener makes the document
  async function saleOf(customerId: string): Promise<string> {
    const made = await createOrder(owner, { storeId: ctx.storeA.id })
    await owner.orderItem.update({
      where: { id: made.itemId },
      data: {
        quantity: 2,
        unitPriceCents: 1130,
        taxTreatment: 'taxed',
        taxRateBps: 1300,
        taxCents: 260
      }
    })
    const order = await owner.order.update({
      where: { id: made.id },
      data: {
        customerId,
        status: OrderStatus.DELIVERED,
        subtotalCents: 2260,
        shippingCents: 565,
        totalCents: 2825,
        taxCents: 325,
        pricesIncludeTax: true,
        deliveredAt: new Date()
      },
      select: { id: true, storeId: true, orderNumber: true }
    })
    await emitter.emitAsync(Events.ORDER_STATUS_CHANGED, {
      storeId: order.storeId,
      orderId: order.id,
      orderNumber: order.orderNumber,
      actor: { type: 'system', id: null },
      from: OrderStatus.SHIPPED,
      to: OrderStatus.DELIVERED,
      notifyCustomer: false
    })
    return order.id
  }

  describe('saving it', () => {
    // Before the organization has an issuer nobody has said what a valid value looks like: the data is kept, within core's limits
    it('keeps what it is sent when the organization has no issuer yet, and answers it masked', async () => {
      const id = await customerA()
      expect((await get(id)).body).toEqual({ data: null })
      const saved = await put(id, {
        name: 'Zq Fiscal Name',
        taxId: TAX_ID,
        registrationId: REGISTRATION,
        taxpayerType: 'company',
        economicActivity: ACTIVITY,
        address: ADDRESS
      })
      expect(saved.status).toBe(OK)
      const data = (saved.body as { data: Record<string, unknown> }).data
      expect(data).toMatchObject({
        name: 'Zq Fiscal Name',
        taxpayerType: 'company',
        economicActivity: ACTIVITY,
        addressSet: true
      })
      // The identifiers show their last characters only and the address is never read back
      const text = JSON.stringify((await get(id)).body)
      for (const secret of [TAX_ID, REGISTRATION, ADDRESS.line1, ADDRESS.city]) {
        expect(text).not.toContain(secret)
      }
      expect(text).toContain(TAX_ID.slice(-4))
    })

    it('seals it: the row holds no readable value, and the audit names the fields and never the values', async () => {
      const id = await customerA()
      await put(id, { taxId: TAX_ID, registrationId: REGISTRATION, address: ADDRESS })
      const row = await owner.customerFiscalData.findUniqueOrThrow({ where: { customerId: id } })
      const raw = Buffer.from(row.dataEncrypted).toString('latin1')
      for (const secret of [TAX_ID, REGISTRATION, ADDRESS.line1]) expect(raw).not.toContain(secret)
      expect(row.updatedBy).toBe(ctx.adminA.id)

      const entries = await waitForAuditEntries(owner, {
        action: AuditAction.FISCAL_CUSTOMER_DATA_CHANGED,
        resourceId: id
      })
      const logged = JSON.stringify(entries)
      for (const secret of [TAX_ID, REGISTRATION, ADDRESS.line1, ADDRESS.city]) {
        expect(logged).not.toContain(secret)
      }
      expect(logged).toContain('taxId')
    })

    it('merges what is sent over what is stored: a field left out stays, a field sent as null goes', async () => {
      const id = await customerA()
      await put(id, { taxId: TAX_ID, name: 'Zq Name', taxpayerType: 'person' })
      const merged = await put(id, { name: null, economicActivity: ACTIVITY })
      const data = (merged.body as { data: Record<string, unknown> }).data
      expect(data).toMatchObject({
        name: null,
        taxpayerType: 'person',
        economicActivity: ACTIVITY
      })
      expect(data['taxId']).toContain(TAX_ID.slice(-4))
    })

    it('clears the row when nothing is left, and DELETE clears it too', async () => {
      const id = await customerA()
      await put(id, { taxId: TAX_ID })
      const emptied = await put(id, { taxId: null })
      expect((emptied.body as { data: unknown }).data).toBeNull()
      expect(await owner.customerFiscalData.count({ where: { customerId: id } })).toBe(0)

      await put(id, { taxId: TAX_ID })
      expect((await asAdminA().delete(ApiRoutes.fiscal.customerData.clear(id))).status).toBe(
        NO_CONTENT
      )
      expect(await owner.customerFiscalData.count({ where: { customerId: id } })).toBe(0)
      expect((await get(id)).body).toEqual({ data: null })
    })

    it('refuses an empty body, a field it does not know and a value of more than one line', async () => {
      const id = await customerA()
      expect((await put(id, {})).status).toBe(BAD_REQUEST)
      expect((await put(id, { taxId: TAX_ID, storeId: ctx.storeB.id })).status).toBe(BAD_REQUEST)
      expect((await put(id, { taxId: 'a\nb' })).status).toBe(BAD_REQUEST)
      expect(await owner.customerFiscalData.count({ where: { customerId: id } })).toBe(0)
    })
  })

  describe('the rules of the provider', () => {
    it('are applied once the organization has an issuer, and the refusal never echoes the value', async () => {
      const issuer = await asAdminA()
        .put(ApiRoutes.fiscal.issuer)
        .send({
          providerId: SIMULATOR_PROVIDER_ID,
          legalName: 'Zq Issuer',
          taxId: 'ZQ-ISSUER',
          address: { line1: 'x' },
          environment: FiscalEnvironment.SANDBOX,
          issueOn: FiscalIssueOn.DELIVERED,
          credentials: { signingKey: 'not-a-real-signing-key-1234567890' }
        })
      expect(issuer.status).toBe(OK)

      const id = await customerA()
      const refused = await put(id, { taxId: 'ZQ 99 88' })
      expect(refused.status).toBe(BAD_REQUEST)
      expect(JSON.stringify(refused.body)).toContain(ErrorCodes.FISCAL_CUSTOMER_DATA_INVALID)
      expect(JSON.stringify(refused.body)).toContain(SimulatorRules.TAX_ID_WITH_SPACES)
      expect(JSON.stringify(refused.body)).not.toContain('ZQ 99 88')
      expect(await owner.customerFiscalData.count({ where: { customerId: id } })).toBe(0)

      expect((await put(id, { taxId: 'ZQ-99-88' })).status).toBe(OK)
    })
  })

  describe('the sale document', () => {
    it('takes a copy when it is made: a later change of the data never reaches it', async () => {
      const customerId = await customerA()
      await put(customerId, { name: 'Zq Fiscal Name', taxId: TAX_ID, taxpayerType: 'company' })
      const orderId = await saleOf(customerId)

      const document = await owner.fiscalDocument.findFirstOrThrow({
        where: { orderId },
        select: { id: true, receiverEncrypted: true }
      })
      const view = await asAdminA().get(ApiRoutes.fiscal.documents.byId(document.id))
      expect(view.status).toBe(OK)
      const receiver = (view.body as { data: { receiver: Record<string, unknown> } }).data.receiver
      // The fiscal name wins over the customer's contact name; the tax id travels masked
      expect(receiver['name']).toBe('Zq Fiscal Name')
      expect(String(receiver['taxIdMasked'])).toContain(TAX_ID.slice(-4))
      expect(String(receiver['taxIdMasked'])).not.toContain(TAX_ID)

      const before = Buffer.from(document.receiverEncrypted)
      await put(customerId, { name: 'Another Name', taxId: 'ZQ-OTHER-0000' })
      await asAdminA().delete(ApiRoutes.fiscal.customerData.clear(customerId))
      const after = await owner.fiscalDocument.findUniqueOrThrow({
        where: { id: document.id },
        select: { receiverEncrypted: true }
      })
      expect(Buffer.from(after.receiverEncrypted).equals(before)).toBe(true)
      const again = await asAdminA().get(ApiRoutes.fiscal.documents.byId(document.id))
      expect((again.body as { data: { receiver: unknown } }).data.receiver).toEqual(receiver)
    })

    it('is made with the contact of the sale when the customer has no fiscal data', async () => {
      const customerId = await customerA()
      const orderId = await saleOf(customerId)
      const document = await owner.fiscalDocument.findFirstOrThrow({
        where: { orderId },
        select: { id: true }
      })
      const view = await asAdminA().get(ApiRoutes.fiscal.documents.byId(document.id))
      const receiver = (view.body as { data: { receiver: Record<string, unknown> } }).data.receiver
      expect(receiver['taxIdMasked']).toBeNull()
    })

    it('is not made when the data cannot be read: a customer with a tax id is never invoiced as a consumer', async () => {
      const made = await createCustomerFiscalData(owner, { storeId: ctx.storeA.id })
      const orderId = await saleOf(made.customerId)
      expect(await owner.fiscalDocument.count({ where: { orderId } })).toBe(0)
    })
  })

  describe('a row that cannot be opened', () => {
    it('is an error to fix, never an empty answer, and writing the data again repairs it', async () => {
      const made = await createCustomerFiscalData(owner, { storeId: ctx.storeA.id })
      const read = await get(made.customerId)
      expect(read.status).toBe(CONFLICT)
      expect(JSON.stringify(read.body)).toContain(ErrorCodes.FISCAL_CUSTOMER_DATA_INVALID)
      expect((await put(made.customerId, { taxId: 'ZQ-FIXED-1' })).status).toBe(OK)
      expect((await get(made.customerId)).status).toBe(OK)
    })
  })

  describe('whose it is', () => {
    it('is the store of the request: another store gets a 404 and changes nothing', async () => {
      const id = await customerA()
      await put(id, { taxId: TAX_ID })
      const read = await asAdminB().get(ApiRoutes.fiscal.customerData.get(id))
      expect(read.status).toBe(NOT_FOUND)
      expect(JSON.stringify(read.body)).not.toContain(TAX_ID.slice(-4))
      const write = await asAdminB()
        .put(ApiRoutes.fiscal.customerData.put(id))
        .send({ taxId: 'hacked' })
      expect(write.status).toBe(NOT_FOUND)
      const cleared = await asAdminB().delete(ApiRoutes.fiscal.customerData.clear(id))
      expect(cleared.status).toBe(NOT_FOUND)
      expect(await owner.customerFiscalData.count({ where: { customerId: id } })).toBe(1)
    })

    it('is never taken from the body: the row lands in the store of the customer', async () => {
      const id = await customerA()
      await put(id, { taxId: TAX_ID })
      const row = await owner.customerFiscalData.findUniqueOrThrow({ where: { customerId: id } })
      expect(row.storeId).toBe(ctx.storeA.id)
      // The database refuses a row whose store is not the customer's
      await expect(
        owner.customerFiscalData.update({
          where: { id: row.id },
          data: { storeId: ctx.storeB.id }
        })
      ).rejects.toThrow(/belongs to the store of the customer/)
    })

    it('goes with its customer', async () => {
      const id = await customerA()
      await put(id, { taxId: TAX_ID })
      await owner.customer.delete({ where: { id } })
      expect(await owner.customerFiscalData.count({ where: { customerId: id } })).toBe(0)
    })

    it('is not given for a customer that was merged into another', async () => {
      const id = await customerA()
      const survivor = await customerA()
      await owner.customer.update({ where: { id }, data: { mergedIntoId: survivor } })
      expect((await put(id, { taxId: TAX_ID })).status).toBe(NOT_FOUND)
    })
  })

  describe('who may', () => {
    it('asks its own permissions, apart from customers:view and from the fiscal documents', async () => {
      const id = await customerA()
      await put(id, { taxId: TAX_ID })
      const as = async (name: string, permissions: Permission[]) =>
        api(
          app,
          await actorWithPermissions(owner, app, {
            prefix,
            name,
            organizationId: ctx.orgA.id,
            storeId: ctx.storeA.id,
            permissions
          }),
          ctx.storeA
        )

      const chat = await as('fiscal-data-chat', [
        Permissions.CUSTOMERS_VIEW,
        Permissions.CUSTOMERS_EDIT,
        Permissions.FISCAL_VIEW,
        Permissions.FISCAL_MANAGE
      ])
      expect((await chat.get(ApiRoutes.fiscal.customerData.get(id))).status).toBe(FORBIDDEN)
      expect(
        (await chat.put(ApiRoutes.fiscal.customerData.put(id)).send({ taxId: 'x' })).status
      ).toBe(FORBIDDEN)

      const viewer = await as('fiscal-data-viewer', [Permissions.FISCAL_VIEW_CUSTOMER_DATA])
      expect((await viewer.get(ApiRoutes.fiscal.customerData.get(id))).status).toBe(OK)
      expect(
        (await viewer.put(ApiRoutes.fiscal.customerData.put(id)).send({ taxId: 'x' })).status
      ).toBe(FORBIDDEN)
      expect((await viewer.delete(ApiRoutes.fiscal.customerData.clear(id))).status).toBe(FORBIDDEN)

      const manager = await as('fiscal-data-manager', [Permissions.FISCAL_MANAGE_CUSTOMER_DATA])
      expect(
        (await manager.put(ApiRoutes.fiscal.customerData.put(id)).send({ name: 'Zq Name' })).status
      ).toBe(OK)
      expect((await manager.get(ApiRoutes.fiscal.customerData.get(id))).status).toBe(FORBIDDEN)
    })

    it('is not in what the customer answers', async () => {
      const id = await customerA()
      await put(id, { taxId: TAX_ID, registrationId: REGISTRATION })
      const detail = await asAdminA().get(ApiRoutes.customers.byId(id))
      expect(detail.status).toBe(OK)
      const text = JSON.stringify(detail.body)
      expect(text).not.toContain(TAX_ID)
      expect(text).not.toContain(TAX_ID.slice(-4))
      expect(text).not.toContain(REGISTRATION)
    })
  })
})
