import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { Permissions } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  FinanceCountryCodes,
  JournalEntryType,
  OrderStatus,
  PaymentMethod,
  TaxRounding,
  TaxTreatment,
  VatLineKind,
  VatSide
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'

import { postTestEntry } from '../builders/finance'
import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'
import { type CreatedBody, type ErrorBody, ordersKit, type OrdersKit } from '../helpers/orders'

interface TaxedOrder {
  id: string
  subtotalCents: number
  shippingCents: number
  discountCents: number
  totalCents: number
  taxCents: number | null
  pricesIncludeTax: boolean | null
  shippingTaxRateBps: number | null
  items: {
    id: string
    quantity: number
    unitPriceCents: number
    taxTreatment: string | null
    taxRateBps: number | null
    taxCents: number | null
  }[]
}
interface ReportBody {
  from: string
  to: string
  recognizedOn: string
  rows: {
    month: string
    side: string
    kind: string
    rateBps: number | null
    baseCents: number | null
    taxCents: number
    documents: number
  }[]
  months: { month: string; outputTaxCents: number; inputTaxCents: number; balanceCents: number }[]
  ordersWithoutTaxSnapshot: number
  ordersNotReadable: number
  returnedOrdersIncluded: number
  accountingStartDate: string
}

const OK = 200
const CREATED = 201
const BAD_REQUEST = 400
const FORBIDDEN = 403
const CONFLICT = 409

describe('The tax of an order and the VAT report (Step 4B.3b)', () => {
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
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)
  const errorOf = (response: { body: unknown }) => (response.body as ErrorBody).error
  const read = async (id: string): Promise<TaxedOrder> =>
    (await asAdmin().get(ApiRoutes.orders.byId(id))).body as TaxedOrder
  const dbOrder = (id: string) =>
    owner.order.findUniqueOrThrow({ where: { id }, include: { items: true } })

  // An order through the api: one product at `priceCents`, `quantity` units, plus what the test adds
  async function place(
    priceCents: number,
    quantity: number,
    extra: Record<string, unknown> = {},
    treatment: TaxTreatment = TaxTreatment.TAXED
  ): Promise<TaxedOrder> {
    const product = await kit.stocked(20, 0, priceCents)
    if (treatment !== TaxTreatment.TAXED) {
      await owner.product.update({ where: { id: product.id }, data: { taxTreatment: treatment } })
    }
    const body = await kit.orderBody({ items: [{ productId: product.id, quantity }], ...extra })
    const response = await asAdmin().post(ApiRoutes.orders.create).send(body)
    expect(response.status).toBe(CREATED)
    return (response.body as CreatedBody).order as unknown as TaxedOrder
  }
  // An order made before the tax columns: an order of the books made with its snapshot taken away, as the owner of the database
  async function legacyOrder(): Promise<TaxedOrder> {
    const order = await place(1130, 3, { shippingCents: 500 })
    await owner.orderItem.updateMany({
      where: { orderId: order.id },
      data: { taxTreatment: null, taxRateBps: null, taxCents: null }
    })
    await owner.order.update({
      where: { id: order.id },
      data: { taxCents: null, pricesIncludeTax: null, shippingTaxRateBps: null, taxRounding: null }
    })
    return order
  }
  const setStorePrices = async (pricesIncludeTax: boolean) => {
    const response = await asAdmin()
      .patch(ApiRoutes.finance.storeTaxSettings)
      .send({ pricesIncludeTax, confirmPriceModeChange: true })
    expect(response.status).toBe(OK)
  }

  describe('an organization with no books', () => {
    it('keeps its orders as they were: no tax snapshot and the price alone as the total', async () => {
      const order = await place(1130, 3, { shippingCents: 500 })

      expect(order).toMatchObject({
        totalCents: 3390 + 500,
        taxCents: null,
        pricesIncludeTax: null
      })
      expect(order.items.map(item => [item.taxTreatment, item.taxRateBps, item.taxCents])).toEqual([
        [null, null, null]
      ])
      expect((await dbOrder(order.id)).taxCents).toBeNull()
    })
  })

  describe('an organization with its books', () => {
    beforeAll(async () => {
      const setup = await asAdmin()
        .post(ApiRoutes.finance.setup)
        .send({ countryCode: FinanceCountryCodes.EL_SALVADOR, accountingStartDate: '2026-01-01' })
      expect(setup.status).toBe(CREATED)
    })
    afterEach(async () => {
      // What a case changes on the shared books is put back, whether it passed or not
      await owner.taxRate.updateMany({
        where: { organizationId: ctx.orgA.id, code: 'IVA' },
        data: { isDefault: true, active: true, rateBps: 1300 }
      })
      await owner.financeSettings.update({
        where: { organizationId: ctx.orgA.id },
        data: { taxRounding: TaxRounding.HALF_UP, shippingTaxed: true }
      })
      await owner.storeSettings.update({
        where: { storeId: ctx.storeA.id },
        data: { preferences: {} }
      })
    })

    describe('the prices include the tax (the default)', () => {
      it('keeps the total as the price and stores the tax inside it, to the cent', async () => {
        // 3 x 11.30 = 33.90 holds 3.90 of tax at 13 %
        const order = await place(1130, 3)

        expect(order).toMatchObject({
          subtotalCents: 3390,
          totalCents: 3390,
          taxCents: 390,
          pricesIncludeTax: true,
          shippingTaxRateBps: null
        })
        expect(order.items[0]).toMatchObject({
          taxTreatment: 'taxed',
          taxRateBps: 1300,
          taxCents: 390
        })
      })

      it('shares a discount over the lines before taxing them, and taxes the shipping fee', async () => {
        const order = await place(1130, 3, {
          discountCents: 330,
          discountReason: 'vip',
          shippingCents: 565
        })

        // 33.90 - 3.30 = 30.60 holds 3.5203 (3.52); 5.65 holds 0.65: 4.17 of tax; the total is the price alone
        expect(order).toMatchObject({
          totalCents: 3390 - 330 + 565,
          taxCents: 352 + 65,
          shippingTaxRateBps: 1300
        })
        expect(order.items[0]?.taxCents).toBe(352)
      })
    })

    describe('the prices exclude the tax', () => {
      it('adds the tax to the total, computed on what is left after the discount, with the fee taxed', async () => {
        await setStorePrices(false)
        const order = await place(1000, 3, {
          discountCents: 100,
          discountReason: 'vip',
          shippingCents: 500
        })

        // 30.00 - 1.00 = 29.00 x 13 % = 3.77; 5.00 x 13 % = 0.65: 4.42 of tax on top of 30.00 - 1.00 + 5.00
        expect(order).toMatchObject({
          subtotalCents: 3000,
          taxCents: 377 + 65,
          pricesIncludeTax: false,
          totalCents: 3000 - 100 + 500 + 377 + 65
        })
        expect(order.items[0]?.taxCents).toBe(377)
      })

      it('charges the customer the same total as a store whose prices include the tax, for the same goods', async () => {
        const excluded = await (async () => {
          await setStorePrices(false)
          return place(1000, 1)
        })()
        const included = await (async () => {
          await setStorePrices(true)
          return place(1130, 1)
        })()

        expect([excluded.totalCents, included.totalCents]).toEqual([1130, 1130])
        expect([excluded.taxCents, included.taxCents]).toEqual([130, 130])
      })
    })

    describe('what does not carry the tax', () => {
      it.each([TaxTreatment.EXEMPT, TaxTreatment.NOT_SUBJECT])(
        'charges none on a %s product, in either price mode, and says which it was',
        async treatment => {
          for (const includes of [true, false]) {
            await setStorePrices(includes)
            const order = await place(1000, 2, {}, treatment)

            expect(order).toMatchObject({ totalCents: 2000, taxCents: 0 })
            expect(order.items[0]).toMatchObject({
              taxTreatment: treatment,
              taxRateBps: null,
              taxCents: 0
            })
          }
        }
      )

      it('leaves the shipping fee untaxed when the books say so', async () => {
        await owner.financeSettings.update({
          where: { organizationId: ctx.orgA.id },
          data: { shippingTaxed: false }
        })
        const order = await place(1130, 1, { shippingCents: 500 })

        expect(order).toMatchObject({ totalCents: 1630, taxCents: 130, shippingTaxRateBps: null })
      })
    })

    describe('the rate of a product', () => {
      it('takes the rate the product names over the default, and refuses a taxed product with no rate at all', async () => {
        const five = await owner.taxRate.create({
          data: {
            organizationId: ctx.orgA.id,
            code: `R${randomUUID().slice(0, 6)}`,
            name: 'Five',
            rateBps: 500,
            outputAccountId: (
              await owner.taxRate.findFirstOrThrow({
                where: { code: 'IVA', organizationId: ctx.orgA.id }
              })
            ).outputAccountId,
            inputAccountId: (
              await owner.taxRate.findFirstOrThrow({
                where: { code: 'IVA', organizationId: ctx.orgA.id }
              })
            ).inputAccountId
          }
        })
        const product = await kit.stocked(20, 0, 1050)
        await owner.product.update({ where: { id: product.id }, data: { taxRateId: five.id } })
        const own = await asAdmin()
          .post(ApiRoutes.orders.create)
          .send(await kit.orderBody({ items: [{ productId: product.id, quantity: 1 }] }))
        expect(own.status).toBe(CREATED)
        // 10.50 holds 0.50 at 5 %
        expect(((own.body as CreatedBody).order as unknown as TaxedOrder).taxCents).toBe(50)

        await owner.taxRate.updateMany({
          where: { organizationId: ctx.orgA.id, isDefault: true },
          data: { isDefault: false }
        })
        const plain = await kit.stocked(20, 0, 1000)
        const refused = await asAdmin()
          .post(ApiRoutes.orders.create)
          .send(await kit.orderBody({ items: [{ productId: plain.id, quantity: 1 }] }))
        const exempt = await kit.stocked(20, 0, 1000)
        await owner.product.update({
          where: { id: exempt.id },
          data: { taxTreatment: TaxTreatment.EXEMPT }
        })
        const fine = await asAdmin()
          .post(ApiRoutes.orders.create)
          .send(await kit.orderBody({ items: [{ productId: exempt.id, quantity: 1 }] }))

        expect(refused.status).toBe(CONFLICT)
        expect(errorOf(refused).code).toBe(ErrorCodes.FINANCE_TAX_RATE_NOT_CONFIGURED)
        expect(fine.status).toBe(CREATED)
      })
    })

    describe('the snapshot', () => {
      it('does not move when the rate, the rounding or the price mode of the store change', async () => {
        const order = await place(1130, 3)
        await owner.taxRate.updateMany({
          where: { organizationId: ctx.orgA.id, code: 'IVA' },
          data: { rateBps: 1500 }
        })
        await owner.financeSettings.update({
          where: { organizationId: ctx.orgA.id },
          data: { taxRounding: TaxRounding.DOWN }
        })
        await setStorePrices(false)

        const after = await read(order.id)
        expect(after).toMatchObject({ taxCents: 390, totalCents: 3390, pricesIncludeTax: true })
        expect(after.items[0]).toMatchObject({ taxRateBps: 1300, taxCents: 390 })
        // An order made now takes the new rate and the new price mode
        const fresh = await place(1000, 1)
        expect(fresh).toMatchObject({ taxCents: 150, pricesIncludeTax: false, totalCents: 1150 })
      })

      it('keeps its rounding when the same items are sent again after the books changed theirs', async () => {
        await setStorePrices(false)
        // 50 cents at 13 % is 6.5 cents: half up places 7, half even places 6
        const order = await place(50, 1)
        const productId = (await dbOrder(order.id)).items[0]?.productId ?? ''
        expect(order).toMatchObject({ taxCents: 7, totalCents: 57 })
        expect(await dbOrder(order.id)).toMatchObject({ taxRounding: TaxRounding.HALF_UP })
        await owner.financeSettings.update({
          where: { organizationId: ctx.orgA.id },
          data: { taxRounding: TaxRounding.HALF_EVEN }
        })

        const resent = await asAdmin()
          .patch(ApiRoutes.orders.byId(order.id))
          .send({ items: [{ productId, quantity: 1 }] })
        const after = await read(order.id)

        expect(resent.status).toBe(OK)
        expect(after).toMatchObject({ taxCents: 7, totalCents: 57 })
        expect(after.items[0]).toMatchObject({ taxCents: 7 })
        expect(await dbOrder(order.id)).toMatchObject({ taxRounding: TaxRounding.HALF_UP })
        // An order made now takes the new rounding
        expect(await place(50, 1)).toMatchObject({ taxCents: 6, totalCents: 56 })
      })

      it('prices an order made before its rounding was kept with the rounding of the books of that day', async () => {
        await setStorePrices(false)
        const order = await place(50, 1)
        const productId = (await dbOrder(order.id)).items[0]?.productId ?? ''
        await owner.order.update({ where: { id: order.id }, data: { taxRounding: null } })
        await owner.financeSettings.update({
          where: { organizationId: ctx.orgA.id },
          data: { taxRounding: TaxRounding.HALF_EVEN }
        })

        const resent = await asAdmin()
          .patch(ApiRoutes.orders.byId(order.id))
          .send({ items: [{ productId, quantity: 1 }] })

        expect(resent.status).toBe(OK)
        expect(await read(order.id)).toMatchObject({ taxCents: 6, totalCents: 56 })
        expect(await dbOrder(order.id)).toMatchObject({ taxRounding: TaxRounding.HALF_EVEN })
      })

      it('keeps the rate of its lines, and its price mode, when an edit moves the price', async () => {
        const order = await place(1130, 3)
        await owner.taxRate.updateMany({
          where: { organizationId: ctx.orgA.id, code: 'IVA' },
          data: { rateBps: 1500 }
        })
        await setStorePrices(false)

        const edited = await asAdmin()
          .patch(ApiRoutes.orders.byId(order.id))
          .send({ discountCents: 330, discountReason: 'vip' })
        const after = await read(order.id)

        expect(edited.status).toBe(OK)
        // Still included, still 13 %: 33.90 - 3.30 = 30.60 holds 3.52
        expect(after).toMatchObject({ pricesIncludeTax: true, taxCents: 352, totalCents: 3060 })
        expect(after.items[0]).toMatchObject({ taxRateBps: 1300, taxCents: 352 })
        expect((await dbOrder(order.id)).items.map(item => item.taxCents)).toEqual([352])
      })

      it('leaves the tax and the total of an order exactly as they were when an edit moves nothing the tax is made from', async () => {
        await setStorePrices(false)
        const order = await place(1000, 3, {
          discountCents: 100,
          discountReason: 'vip',
          shippingCents: 500
        })
        // The books change how a cent is placed after the order was quoted
        await owner.financeSettings.update({
          where: { organizationId: ctx.orgA.id },
          data: { taxRounding: TaxRounding.UP }
        })
        const edited = await asAdmin()
          .patch(ApiRoutes.orders.byId(order.id))
          .send({ discountCents: 100, discountReason: 'loyal customer' })
        const after = await read(order.id)

        expect(edited.status).toBe(OK)
        expect(after).toMatchObject({
          taxCents: order.taxCents,
          totalCents: order.totalCents,
          pricesIncludeTax: false
        })
        expect(after.items.map(item => item.taxCents)).toEqual(
          order.items.map(item => item.taxCents)
        )
      })

      it('keeps the rate of a line whose price the edit changes, while the product has moved to another treatment', async () => {
        const order = await place(1130, 1)
        const productId = (await dbOrder(order.id)).items[0]?.productId ?? ''
        await owner.product.update({
          where: { id: productId },
          data: { taxTreatment: TaxTreatment.EXEMPT }
        })
        const edited = await asAdmin()
          .patch(ApiRoutes.orders.byId(order.id))
          .send({
            items: [{ productId, quantity: 1, unitPriceCents: 1230, priceReason: 'negotiated' }]
          })
        const after = await read(order.id)

        expect(edited.status).toBe(OK)
        // Still taxed at the 13 % it was made at: 12.30 holds 1.4159, so 1.42
        expect(after.items[0]).toMatchObject({
          taxTreatment: 'taxed',
          taxRateBps: 1300,
          taxCents: 142
        })
        expect(after.totalCents).toBe(1230)
      })

      it('follows the lines of an edit: the lines it keeps keep their rate and the one it adds takes the rate of today', async () => {
        const order = await place(1130, 1)
        await owner.taxRate.updateMany({
          where: { organizationId: ctx.orgA.id, code: 'IVA' },
          data: { rateBps: 1500 }
        })
        const keptProductId = (await dbOrder(order.id)).items[0]?.productId ?? ''
        const added = await kit.stocked(20, 0, 1150)
        const response = await asAdmin()
          .patch(ApiRoutes.orders.byId(order.id))
          .send({
            items: [
              {
                productId: keptProductId,
                quantity: 1
              },
              { productId: added.id, quantity: 1 }
            ]
          })
        const after = await read(order.id)

        expect(response.status).toBe(OK)
        // 11.30 holds 1.30 at 13 %; 11.50 holds 1.50 at 15 %
        expect(after.items.map(item => [item.taxRateBps, item.taxCents]).sort()).toEqual([
          [1300, 130],
          [1500, 150]
        ])
        expect(after).toMatchObject({ taxCents: 280, totalCents: 2280 })
      })

      it('leaves an order made before the tax columns as it was, even when it is edited', async () => {
        const legacy = await legacyOrder()
        const edited = await asAdmin()
          .patch(ApiRoutes.orders.byId(legacy.id))
          .send({ discountCents: 100, discountReason: 'vip' })
        const after = await read(legacy.id)

        expect(edited.status).toBe(OK)
        expect(after).toMatchObject({
          taxCents: null,
          pricesIncludeTax: null,
          totalCents: 3390 + 500 - 100
        })
        expect(after.items[0]).toMatchObject({
          taxTreatment: null,
          taxRateBps: null,
          taxCents: null
        })
      })

      it('taxes the replacement order of an exchange on what is left after the credit of the return', async () => {
        // 2 units of 11.30 come back (credit 22.60); 3 units of 11.30 go out (33.90): the customer pays 11.30, holding 1.30 of tax
        const product = await kit.stocked(20, 0, 1130)
        const created = await asAdmin()
          .post(ApiRoutes.orders.create)
          .send(await kit.orderBody({ items: [{ productId: product.id, quantity: 2 }] }))
        const order = (created.body as CreatedBody).order
        for (const next of [OrderStatus.CONFIRMED, OrderStatus.SHIPPED, OrderStatus.DELIVERED]) {
          const moved = await asAdmin()
            .post(ApiRoutes.orders.status(order.id))
            .send({ status: next })
          expect(moved.status).toBe(OK)
        }
        // The status route stamps the real time: the order is put in a year no report of this suite reads
        await owner.order.update({
          where: { id: order.id },
          data: {
            shippedAt: new Date('2020-01-01T15:00:00Z'),
            deliveredAt: new Date('2020-01-01T15:00:00Z')
          }
        })
        const itemId = (await dbOrder(order.id)).items[0]?.id ?? ''
        const ret = (
          await asAdmin()
            .post(ApiRoutes.returns.create)
            .send({
              orderId: order.id,
              type: 'exchange',
              reason: 'WRONG_ITEM',
              lines: [{ orderItemId: itemId, quantity: 2 }]
            })
        ).body as { id: string }
        const other = await kit.stocked(20, 0, 1130)
        const approved = await asAdmin()
          .post(ApiRoutes.returns.approve(ret.id))
          .send({
            replacement: {
              items: [{ productId: other.id, quantity: 3 }],
              paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
              recipientPhones: ['71234567']
            }
          })
        const replacementId = (approved.body as { replacementOrderId: string }).replacementOrderId
        const replacement = await read(replacementId)

        expect(approved.status).toBe(OK)
        expect(replacement).toMatchObject({
          subtotalCents: 3390,
          discountCents: 2260,
          totalCents: 1130,
          taxCents: 130,
          pricesIncludeTax: true
        })
        expect(replacement.items[0]).toMatchObject({ taxRateBps: 1300, taxCents: 130 })
      })
    })

    describe('the database', () => {
      it('refuses a half-written tax snapshot on an order', async () => {
        const order = await place(1130, 1)
        await expect(
          owner.order.update({
            where: { id: order.id },
            data: { taxCents: null, taxRounding: null }
          })
        ).rejects.toThrow(/orders_tax_snapshot_check/)
        await expect(
          owner.order.update({ where: { id: order.id }, data: { taxCents: -1 } })
        ).rejects.toThrow(/orders_tax_cents_check/)
        // A rounding with no snapshot to belong to, and one that is no rounding
        await expect(
          owner.order.update({ where: { id: order.id }, data: { taxCents: null } })
        ).rejects.toThrow(/orders_tax_rounding_check/)
        await expect(
          owner.order.update({ where: { id: order.id }, data: { taxRounding: 'banker' } })
        ).rejects.toThrow(/orders_tax_rounding_check/)
      })
    })

    describe('the VAT report', () => {
      const FROM = '2027-03-01'
      const TO = '2027-03-31'
      const delivered = (id: string, at = '2027-03-10T15:00:00Z') =>
        owner.order.update({
          where: { id },
          data: {
            status: OrderStatus.DELIVERED,
            shippedAt: new Date(at),
            deliveredAt: new Date(at)
          }
        })
      const report = async (from = FROM, to = TO) =>
        asAdmin().get(`${ApiRoutes.finance.reports.vat}?from=${from}&to=${to}`)

      it('adds up to the orders of the period, in both price modes, with the exempt and the untaxed fee in their own lines', async () => {
        const orders: TaxedOrder[] = []
        await setStorePrices(true)
        orders.push(
          await place(1130, 3, { discountCents: 330, discountReason: 'vip', shippingCents: 565 })
        )
        orders.push(await place(1000, 2, {}, TaxTreatment.EXEMPT))
        await setStorePrices(false)
        orders.push(
          await place(1000, 3, { discountCents: 100, discountReason: 'vip', shippingCents: 500 })
        )
        orders.push(await place(500, 1, {}, TaxTreatment.NOT_SUBJECT))
        for (const order of orders) await delivered(order.id)
        // Not a sale in the range: another month, cancelled, never delivered
        const late = await place(1130, 1)
        await delivered(late.id, '2027-04-05T15:00:00Z')
        const cancelled = await place(1130, 1)
        await owner.order.update({
          where: { id: cancelled.id },
          data: { status: OrderStatus.CANCELLED, deliveredAt: new Date('2027-03-10T15:00:00Z') }
        })
        await place(1130, 1)

        const response = await report()
        const body = response.body as ReportBody
        const output = body.rows.filter(row => row.side === (VatSide.OUTPUT as string))
        const paid = orders.reduce((sum, order) => sum + order.totalCents, 0)

        expect(response.status).toBe(OK)
        expect(body.recognizedOn).toBe('delivered')
        // Without the legacy order of the first case, which is delivered below in another test
        expect(output.reduce((sum, row) => sum + (row.baseCents ?? 0) + row.taxCents, 0)).toBe(paid)
        expect(output.map(row => row.kind).sort()).toEqual(
          [VatLineKind.TAXED, VatLineKind.EXEMPT, VatLineKind.NOT_SUBJECT].sort()
        )
        expect(output.find(row => row.kind === (VatLineKind.TAXED as string))).toMatchObject({
          month: '2027-03',
          rateBps: 1300,
          taxCents: 352 + 65 + 377 + 65
        })
        expect(body.months).toEqual([
          {
            month: '2027-03',
            outputTaxCents: 352 + 65 + 377 + 65,
            inputTaxCents: 0,
            balanceCents: 859
          }
        ])
        expect(body.ordersNotReadable).toBe(0)
      })

      it('counts the orders made before the tax columns apart and does not estimate them', async () => {
        const before = ((await report()).body as ReportBody).ordersWithoutTaxSnapshot
        const legacy = await legacyOrder()
        await delivered(legacy.id)
        const body = (await report()).body as ReportBody
        expect(body.ordersWithoutTaxSnapshot).toBe(before + 1)
      })

      it('puts the tax the books credited on the input side and the balance is output less input', async () => {
        const rate = await owner.taxRate.findFirstOrThrow({
          where: { organizationId: ctx.orgA.id, code: 'IVA' }
        })
        const vatInput = await owner.accountRoleMapping.findUniqueOrThrow({
          where: { organizationId_role: { organizationId: ctx.orgA.id, role: 'vat_input' } }
        })
        const cash = await owner.accountRoleMapping.findUniqueOrThrow({
          where: { organizationId_role: { organizationId: ctx.orgA.id, role: 'cash_default' } }
        })
        const period = await owner.fiscalPeriod.findFirstOrThrow({
          where: { organizationId: ctx.orgA.id },
          orderBy: { startsOn: 'asc' }
        })
        await postTestEntry(owner, {
          organizationId: ctx.orgA.id,
          periodId: period.id,
          entryDate: '2026-01-15',
          lines: [
            { accountId: vatInput.accountId, debitCents: 130, taxRateId: rate.id },
            { accountId: cash.accountId, creditCents: 130 }
          ]
        })
        const body = (await report('2026-01-01', '2026-01-31')).body as ReportBody

        expect(body.rows).toEqual([
          {
            month: '2026-01',
            side: VatSide.INPUT,
            kind: VatLineKind.TAXED,
            rateBps: 1300,
            baseCents: null,
            taxCents: 130,
            documents: 1
          }
        ])
        expect(body.months).toEqual([
          { month: '2026-01', outputTaxCents: 0, inputTaxCents: 130, balanceCents: -130 }
        ])
      })

      it('takes the tax a return gave back off the output side, in the month of its entry, and a void gives it back (HC-003)', async () => {
        const role = async (name: string): Promise<string> =>
          (
            await owner.accountRoleMapping.findUniqueOrThrow({
              where: { organizationId_role: { organizationId: ctx.orgA.id, role: name } }
            })
          ).accountId
        // A month of its own: the entries of the books cannot be removed, so no other test reads it
        const period = await owner.fiscalPeriod.findFirstOrThrow({
          where: { organizationId: ctx.orgA.id, year: 2026, month: 2 }
        })
        const post = async (day: string, vat: number, net: number): Promise<{ id: string }> =>
          postTestEntry(owner, {
            organizationId: ctx.orgA.id,
            periodId: period.id,
            entryDate: day,
            type: JournalEntryType.SALE_RETURN,
            lines: [
              { accountId: await role('sales_returns'), debitCents: net },
              ...(vat > 0 ? [{ accountId: await role('vat_output'), debitCents: vat }] : []),
              { accountId: await role('customer_advances'), creditCents: net + vat }
            ]
          })
        const first = await post('2026-02-10', 130, 1000)
        // Goods with no tax: no tax to take off, but the base and the document are still there
        await post('2026-02-11', 0, 500)
        const row = async (): Promise<ReportBody['rows'][number] | undefined> =>
          ((await report('2026-02-01', '2026-02-28')).body as ReportBody).rows.find(
            line => line.kind === (VatLineKind.RETURNS as string)
          )
        expect(await row()).toEqual({
          month: '2026-02',
          side: VatSide.OUTPUT,
          kind: VatLineKind.RETURNS,
          rateBps: null,
          baseCents: -1500,
          taxCents: -130,
          documents: 2
        })
        const month = ((await report('2026-02-01', '2026-02-28')).body as ReportBody).months.find(
          line => line.month === '2026-02'
        )
        expect(month).toEqual({
          month: '2026-02',
          outputTaxCents: -130,
          inputTaxCents: 0,
          balanceCents: -130
        })

        // The void of the first return is its reversing entry: it gives the tax back in its own month
        await postTestEntry(owner, {
          organizationId: ctx.orgA.id,
          periodId: period.id,
          entryDate: '2026-02-12',
          type: JournalEntryType.REVERSAL,
          reversesEntryId: first.id,
          lines: [
            { accountId: await role('sales_returns'), creditCents: 1000 },
            { accountId: await role('vat_output'), creditCents: 130 },
            { accountId: await role('customer_advances'), debitCents: 1130 }
          ]
        })
        expect(await row()).toMatchObject({ baseCents: -500, taxCents: 0, documents: 1 })
      })

      it('counts a returned order apart, and tells the date the books start from', async () => {
        const order = await place(1130, 1)
        await delivered(order.id, '2027-05-10T15:00:00Z')
        await owner.order.update({
          where: { id: order.id },
          data: { status: OrderStatus.RETURNED }
        })
        const body = (await report('2027-05-01', '2027-05-31')).body as ReportBody

        expect(body.returnedOrdersIncluded).toBe(1)
        expect(body.accountingStartDate).toBe('2026-01-01')
        expect(body.rows.filter(row => row.side === (VatSide.OUTPUT as string))).toHaveLength(1)
      })

      it('reads the input tax from the input account of the rate too, and does not count a reversal as a document', async () => {
        const vat = await owner.taxRate.findFirstOrThrow({
          where: { organizationId: ctx.orgA.id, code: 'IVA' }
        })
        const other = await owner.ledgerAccount.create({
          data: {
            organizationId: ctx.orgA.id,
            code: `V${randomUUID().slice(0, 6)}`,
            name: 'Other credit',
            type: 'asset',
            normalSide: 'debit'
          }
        })
        const reduced = await owner.taxRate.create({
          data: {
            organizationId: ctx.orgA.id,
            code: `X${randomUUID().slice(0, 6)}`,
            name: 'Reduced',
            rateBps: 100,
            outputAccountId: vat.outputAccountId,
            inputAccountId: other.id
          }
        })
        const cash = await owner.accountRoleMapping.findUniqueOrThrow({
          where: { organizationId_role: { organizationId: ctx.orgA.id, role: 'cash_default' } }
        })
        const period = await owner.fiscalPeriod.findFirstOrThrow({
          where: { organizationId: ctx.orgA.id },
          orderBy: { startsOn: 'asc' }
        })
        const first = await postTestEntry(owner, {
          organizationId: ctx.orgA.id,
          periodId: period.id,
          entryDate: '2026-01-20',
          lines: [
            { accountId: other.id, debitCents: 10, taxRateId: reduced.id },
            { accountId: cash.accountId, creditCents: 10 }
          ]
        })
        await postTestEntry(owner, {
          organizationId: ctx.orgA.id,
          periodId: period.id,
          entryDate: '2026-01-20',
          reversesEntryId: first.id,
          type: JournalEntryType.REVERSAL,
          lines: [
            { accountId: other.id, creditCents: 10, taxRateId: reduced.id },
            { accountId: cash.accountId, debitCents: 10 }
          ]
        })
        await postTestEntry(owner, {
          organizationId: ctx.orgA.id,
          periodId: period.id,
          entryDate: '2026-01-21',
          lines: [
            { accountId: other.id, debitCents: 7, taxRateId: reduced.id },
            { accountId: cash.accountId, creditCents: 7 }
          ]
        })
        const body = (await report('2026-01-20', '2026-01-31')).body as ReportBody
        const row = body.rows.find(candidate => candidate.rateBps === 100)

        // 10 and its reversal net to nothing and are one document; the 7 is another
        expect(row).toMatchObject({ side: VatSide.INPUT, taxCents: 7, documents: 2 })
      })

      it('reads the day a sale is recognized in the time zone of its store', async () => {
        // 2027-04-01 03:00 UTC is still the night of 31 March in El Salvador (UTC-6)
        const order = await place(1130, 1)
        await delivered(order.id, '2027-04-01T03:00:00Z')
        const march = (await report('2027-03-31', '2027-03-31')).body as ReportBody
        const april = (await report('2027-04-01', '2027-04-01')).body as ReportBody

        // On its own day only: the single order of that day is in March, and none is in April
        expect(
          march.rows.filter(row => row.side === (VatSide.OUTPUT as string)).map(row => row.taxCents)
        ).toEqual([130])
        expect(april.rows.filter(row => row.side === (VatSide.OUTPUT as string))).toEqual([])
      })

      it('reads the UTC day of a store whose zone the database does not know, and still answers (N-AA-02)', async () => {
        // The api refuses such a zone, so it is a value written around it: one store must not leave the organization with no report
        const { timezone: original } = await owner.store.findUniqueOrThrow({
          where: { id: ctx.storeA.id },
          select: { timezone: true }
        })
        const order = await place(1130, 1)
        await delivered(order.id, '2027-04-01T03:00:00Z')
        const outputTax = async (day: string): Promise<number> =>
          ((await report(day, day)).body as ReportBody).rows
            .filter(row => row.side === (VatSide.OUTPUT as string))
            .reduce((sum, row) => sum + row.taxCents, 0)
        // With its real zone (UTC-6) the instant is still the night of 31 March
        const marchBefore = await outputTax('2027-03-31')
        expect(marchBefore).toBeGreaterThanOrEqual(130)
        expect(await outputTax('2027-04-01')).toBe(0)
        await owner.store.update({
          where: { id: ctx.storeA.id },
          data: { timezone: 'Mars/Phobos' }
        })
        try {
          const april = await report('2027-04-01', '2027-04-01')

          // The zone does not exist: the report answers and reads the UTC day, so what was March 31 is April 1
          expect(april.status).toBe(OK)
          expect(await outputTax('2027-04-01')).toBe(marchBefore)
          expect(await outputTax('2027-03-31')).toBe(0)
        } finally {
          await owner.store.update({ where: { id: ctx.storeA.id }, data: { timezone: original } })
        }
      })

      it('is a CSV with the same rows, with a header and no formula in a cell', async () => {
        await delivered((await legacyOrder()).id)
        const response = await asAdmin().get(
          `${ApiRoutes.finance.reports.vatCsv}?from=${FROM}&to=${TO}`
        )
        const json = (await report()).body as ReportBody

        expect(response.status).toBe(OK)
        expect(response.headers['content-type']).toContain('text/csv')
        expect(response.headers['content-disposition']).toContain('vat-2027-03-01-2027-03-31.csv')
        const lines = response.text.replace('﻿', '').trim().split('\r\n')
        expect(lines[0]).toBe('month,side,kind,rate_bps,base_cents,tax_cents,documents')
        // The rows, the balance of each month, and one warning line for each thing the report counted apart
        const warnings = [
          json.ordersWithoutTaxSnapshot,
          json.ordersNotReadable,
          json.returnedOrdersIncluded
        ].filter(count => count > 0).length
        expect(json.ordersWithoutTaxSnapshot).toBeGreaterThan(0)
        expect(lines).toHaveLength(1 + json.rows.length + json.months.length + warnings)
        expect(lines).toContain(`2027-03,balance,,,,${String(json.months[0]?.balanceCents)},`)
        expect(lines.some(line => line.startsWith(',warning,orders_without_tax_snapshot'))).toBe(
          true
        )
      })

      it('refuses a range that is backwards, longer than a year, or not dates, and an organization or store in the query', async () => {
        const bad = [
          await report('2027-03-31', '2027-03-01'),
          await report('2026-01-01', '2027-03-31'),
          await asAdmin().get(`${ApiRoutes.finance.reports.vat}?from=nope&to=2027-03-31`),
          await asAdmin().get(
            `${ApiRoutes.finance.reports.vat}?from=${FROM}&to=${TO}&organizationId=${ctx.orgB.id}`
          ),
          await asAdmin().get(ApiRoutes.finance.reports.vat)
        ]
        expect(bad.map(response => response.status)).toEqual(Array(5).fill(BAD_REQUEST))
      })

      it('needs finance:view, and never counts the orders of another organization', async () => {
        const viewer = api(
          app,
          await actorWithPermissions(owner, app, {
            prefix,
            name: 'vat-viewer',
            organizationId: ctx.orgA.id,
            storeId: ctx.storeA.id,
            permissions: [Permissions.FINANCE_VIEW]
          }),
          ctx.storeA
        )
        const nobody = api(
          app,
          await actorWithPermissions(owner, app, {
            prefix,
            name: 'vat-nobody',
            organizationId: ctx.orgA.id,
            storeId: ctx.storeA.id,
            permissions: [Permissions.PRODUCTS_VIEW]
          }),
          ctx.storeA
        )
        const before = (await report()).body as ReportBody
        // An order of organization B, delivered in the range, with a tax snapshot of its own
        const { createOrder } = await import('../builders/order')
        const theirs = await createOrder(owner, { storeId: ctx.storeB.id })
        await owner.order.update({
          where: { id: theirs.id },
          data: {
            status: OrderStatus.DELIVERED,
            deliveredAt: new Date('2027-03-12T15:00:00Z'),
            taxCents: 999,
            pricesIncludeTax: true
          }
        })
        await owner.orderItem.updateMany({
          where: { orderId: theirs.id },
          data: { taxTreatment: 'taxed', taxRateBps: 1300, taxCents: 999 }
        })
        const after = (await report()).body as ReportBody

        expect(
          (await viewer.get(`${ApiRoutes.finance.reports.vat}?from=${FROM}&to=${TO}`)).status
        ).toBe(OK)
        expect(
          (await nobody.get(`${ApiRoutes.finance.reports.vat}?from=${FROM}&to=${TO}`)).status
        ).toBe(FORBIDDEN)
        expect(
          (await nobody.get(`${ApiRoutes.finance.reports.vatCsv}?from=${FROM}&to=${TO}`)).status
        ).toBe(FORBIDDEN)
        expect(after).toEqual(before)
      })
    })
  })
})
