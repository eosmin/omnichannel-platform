import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import type { OwnerClient } from '@platform/core/database-testing'
import { FinanceCountryCodes, SaleRecognition } from '@platform/core/domain'

import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { type CreatedBody, type OrderBody, ordersKit, type OrdersKit } from '../helpers/orders'

const OK = 200
const CREATED = 201
const BAD_REQUEST = 400

// A delivery moment the agent names (HC-209 c): before the day the books of the organization begin the sale would never be
// posted (TDD_18 §6.1) and the VAT report leaves it out, so the date is refused. The day is the one of the store (UTC-6 here).
describe('The delivery moment of an order and the day the books begin', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let kit: OrdersKit

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    kit = ordersKit(owner, app, ctx)
    // The edge cases below are by the day of this zone (UTC-6), so the spec names it instead of trusting the default
    await owner.store.update({
      where: { id: ctx.storeA.id },
      data: { timezone: 'America/El_Salvador' }
    })
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  async function shipped() {
    const product = await kit.stocked(10)
    const body = await kit.orderBody({ items: [{ productId: product.id, quantity: 1 }] })
    const made = await kit.asAdmin().post(ApiRoutes.orders.create).send(body)
    expect(made.status).toBe(CREATED)
    const id = (made.body as CreatedBody).order.id
    await kit.asAdmin().post(ApiRoutes.orders.status(id)).send({ status: 'CONFIRMED' })
    await kit.asAdmin().post(ApiRoutes.orders.status(id)).send({ status: 'SHIPPED' })
    // Shipped long ago, so that "delivered before it shipped" does not answer first
    await owner.order.update({
      where: { id },
      data: { shippedAt: new Date('2020-01-01T00:00:00Z') }
    })
    return id
  }
  const deliver = (id: string, deliveredAt?: string) =>
    kit
      .asAdmin()
      .post(ApiRoutes.orders.status(id))
      .send({ status: 'DELIVERED', ...(deliveredAt === undefined ? {} : { deliveredAt }) })
  const get = async (id: string) =>
    (await kit.asAdmin().get(ApiRoutes.orders.byId(id))).body as OrderBody

  it('keeps accepting any past moment while the organization has no books', async () => {
    const id = await shipped()

    const response = await deliver(id, '2020-06-01T15:00:00Z')

    expect(response.status).toBe(OK)
    expect((await get(id)).status).toBe('DELIVERED')
  })

  describe('an organization with its books starting on 2026-03-15', () => {
    beforeAll(async () => {
      const setup = await kit
        .asAdmin()
        .post(ApiRoutes.finance.setup)
        .send({ countryCode: FinanceCountryCodes.EL_SALVADOR, accountingStartDate: '2026-03-15' })
      expect(setup.status).toBe(CREATED)
    })

    it('refuses a moment before the start, by the day of the store, and keeps the order shipped', async () => {
      const early = await shipped()
      const eve = await shipped()

      // 20:00 of the 14th in the store (02:00 UTC of the 15th): the day before the start
      const well = await deliver(early, '2026-03-10T15:00:00Z')
      const edge = await deliver(eve, '2026-03-15T02:00:00Z')

      for (const response of [well, edge]) {
        expect(response.status).toBe(BAD_REQUEST)
        expect(JSON.stringify(response.body)).toContain('delivered_before_accounting_start')
      }
      expect((await get(early)).status).toBe('SHIPPED')
      expect((await get(eve)).status).toBe('SHIPPED')
    })

    it('answers that it shipped later when the moment is before both the shipping and the start', async () => {
      const id = await shipped()
      await owner.order.update({
        where: { id },
        data: { shippedAt: new Date('2026-03-12T00:00:00Z') }
      })

      const response = await deliver(id, '2026-03-10T15:00:00Z')

      expect(response.status).toBe(BAD_REQUEST)
      expect(JSON.stringify(response.body)).toContain('delivered_before_shipped')
    })

    it('takes a moment before the start when the sales count on the shipping, which the delivery does not move', async () => {
      const id = await shipped()
      await owner.financeSettings.update({
        where: { organizationId: ctx.orgA.id },
        data: { recognizeSaleOn: SaleRecognition.SHIPPED }
      })
      try {
        const response = await deliver(id, '2026-03-10T15:00:00Z')

        expect(response.status).toBe(OK)
      } finally {
        await owner.financeSettings.update({
          where: { organizationId: ctx.orgA.id },
          data: { recognizeSaleOn: SaleRecognition.DELIVERED }
        })
      }
    })

    it('takes the first day of the books, a later day, and no moment at all (now)', async () => {
      const first = await shipped()
      const later = await shipped()
      const now = await shipped()

      // 01:00 of the 15th in the store: the first day counts
      expect((await deliver(first, '2026-03-15T07:00:00Z')).status).toBe(OK)
      expect((await deliver(later, '2026-03-20T15:00:00Z')).status).toBe(OK)
      // The moment of the call is never refused here, whatever the start is
      expect((await deliver(now)).status).toBe(OK)
    })
  })
})
