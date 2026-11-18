import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { Permissions } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  FinanceConflicts,
  FinanceCountryCodes,
  JournalEntryType,
  ProductConflicts,
  TaxKind,
  TaxRounding,
  TaxTreatment
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'

import { createFinanceFixture, type FinanceFixture } from '../builders/finance'
import { createOrder } from '../builders/order'
import { createProduct } from '../builders/product'
import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

interface ErrorBody {
  error: { code: string; metadata?: Record<string, unknown> }
}
interface TaxRateBody {
  id: string
  code: string
  name: string
  rateBps: number
  kind: string
  outputAccountId: string
  inputAccountId: string
  active: boolean
  isDefault: boolean
}

const OK = 200
const CREATED = 201
const BAD_REQUEST = 400
const FORBIDDEN = 403
const NOT_FOUND = 404
const CONFLICT = 409

describe('The tax rates, the tax of a product and the tax settings of a store (Step 4B.3)', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let accounts: Record<string, string> = {}

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    const setup = await asAdminA()
      .post(ApiRoutes.finance.setup)
      .send({ countryCode: FinanceCountryCodes.EL_SALVADOR, accountingStartDate: '2026-01-01' })
    expect(setup.status).toBe(CREATED)
    const rows = await owner.ledgerAccount.findMany({
      where: { organizationId: ctx.orgA.id },
      select: { id: true, code: true }
    })
    accounts = Object.fromEntries(rows.map(row => [row.code, row.id]))
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  // What the cases change on the shared books of A is put back after each one, whether it passed or not
  afterEach(async () => {
    const vat = await owner.taxRate.findFirst({
      where: { organizationId: ctx.orgA.id, code: 'IVA' }
    })
    if (vat !== null) {
      await owner.taxRate.updateMany({
        where: { organizationId: ctx.orgA.id, isDefault: true },
        data: { isDefault: false }
      })
      await owner.taxRate.update({ where: { id: vat.id }, data: { isDefault: true, active: true } })
    }
    await owner.financeSettings.update({
      where: { organizationId: ctx.orgA.id },
      data: { taxRounding: TaxRounding.HALF_UP, shippingTaxed: true }
    })
    for (const store of [ctx.storeA, ctx.storeB]) {
      await owner.storeSettings.update({ where: { storeId: store.id }, data: { preferences: {} } })
    }
  })

  const asAdminA = () => api(app, ctx.adminA, ctx.storeA)
  const errorOf = (response: { body: unknown }) => (response.body as ErrorBody).error
  const code = (): string => `T${randomUUID().slice(0, 8)}`
  const asRole = async (
    name: string,
    permissions: readonly (typeof Permissions)[keyof typeof Permissions][]
  ) =>
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
  const newRate = (extra: Record<string, unknown> = {}) => ({
    code: code(),
    name: 'A rate',
    rateBps: 500,
    outputAccountId: accounts['2201'],
    inputAccountId: accounts['1401'],
    ...extra
  })
  async function createRate(extra: Record<string, unknown> = {}): Promise<TaxRateBody> {
    const response = await asAdminA().post(ApiRoutes.finance.taxRates.create).send(newRate(extra))
    expect(response.status).toBe(CREATED)
    return response.body as TaxRateBody
  }
  const listRates = async (): Promise<TaxRateBody[]> =>
    (await asAdminA().get(ApiRoutes.finance.taxRates.list)).body as TaxRateBody[]

  describe('the setup', () => {
    it('seeds the 13 % rate as the default, with the accounts of the VAT roles, and the tax settings of the books', async () => {
      const rates = await listRates()
      const vat = rates.find(rate => rate.code === 'IVA')

      expect(vat).toMatchObject({
        rateBps: 1300,
        kind: 'vat',
        active: true,
        isDefault: true,
        outputAccountId: accounts['2201'],
        inputAccountId: accounts['1401']
      })
      expect(rates.filter(rate => rate.isDefault)).toHaveLength(1)
      const settings = await asAdminA().get(ApiRoutes.finance.settings)
      expect(settings.body).toMatchObject({ taxRounding: 'half_up', shippingTaxed: true })
    })
  })

  describe('the rates', () => {
    it('creates one, and a second one with the same code is a conflict', async () => {
      const rate = await createRate({ rateBps: 0, name: 'Zero' })
      const again = await asAdminA()
        .post(ApiRoutes.finance.taxRates.create)
        .send(newRate({ code: rate.code }))

      expect(rate).toMatchObject({ rateBps: 0, isDefault: false, active: true })
      expect(again.status).toBe(CONFLICT)
      expect(errorOf(again).metadata).toMatchObject({
        conflict: FinanceConflicts.TAX_RATE_CODE_IN_USE
      })
    })

    it.each([
      ['a rate as a percent with a fraction of a basis point', { rateBps: 13.5 }],
      ['a negative rate', { rateBps: -1 }],
      ['a rate above 100 %', { rateBps: 10_001 }],
      ['a field it does not know', { organizationId: randomUUID() }],
      ['a code with a space', { code: 'A B' }]
    ])('refuses %s', async (_name, extra) => {
      const response = await asAdminA().post(ApiRoutes.finance.taxRates.create).send(newRate(extra))
      expect(response.status).toBe(BAD_REQUEST)
    })

    it('refuses an account that is a header, or one of another organization, as a 404 for the other organization', async () => {
      const header = await asAdminA()
        .post(ApiRoutes.finance.taxRates.create)
        .send(newRate({ outputAccountId: accounts['2'] }))
      const theirs = await booksOfB()
      const other = await asAdminA()
        .post(ApiRoutes.finance.taxRates.create)
        .send(newRate({ inputAccountId: theirs.accounts.cash }))

      expect(header.status).toBe(CONFLICT)
      expect(errorOf(header).code).toBe(ErrorCodes.FINANCE_ACCOUNT_NOT_POSTABLE)
      expect(other.status).toBe(NOT_FOUND)
    })

    it('changes the basis points of a rate and audits what it was and what it is', async () => {
      const rate = await createRate()
      const changed = await asAdminA()
        .patch(ApiRoutes.finance.taxRates.byId(rate.id))
        .send({ rateBps: 1000, name: 'Ten' })

      expect(changed.status).toBe(OK)
      expect(changed.body).toMatchObject({ rateBps: 1000, name: 'Ten' })
      // The creation and the change: two rows, and the change is the one that says what it was and what it is
      const found = await waitForAuditEntries(
        owner,
        { action: AuditAction.FINANCE_TAX_RATE_CHANGED, resourceId: rate.id },
        2
      )
      expect(found.map(row => (row.metadata as { change?: string }).change).sort()).toEqual([
        'created',
        'updated'
      ])
      expect(
        found.find(row => (row.metadata as { change?: string }).change === 'updated')?.metadata
      ).toMatchObject({
        changes: { rateBps: { from: 500, to: 1000 } }
      })
    })

    it('keeps the accounts of a rate that holds posted tax, moves them once it nets to zero, and still edits its name (HC-119)', async () => {
      const rate = await createRate()
      const post = async (side: 'tax-in' | 'tax-back') => {
        const posted = await asAdminA()
          .post(ApiRoutes.finance.entries.manual)
          .send({
            idempotencyKey: randomUUID(),
            entryDate: new Date().toISOString().slice(0, 10),
            type: JournalEntryType.MANUAL,
            memo: 'Tax of the suite',
            lines:
              side === 'tax-in'
                ? [
                    { accountId: accounts['1401'], debitCents: 50, taxRateId: rate.id },
                    { accountId: accounts['1101'], creditCents: 50 }
                  ]
                : [
                    { accountId: accounts['1401'], creditCents: 50, taxRateId: rate.id },
                    { accountId: accounts['1101'], debitCents: 50 }
                  ]
          })
        expect(posted.status).toBe(CREATED)
      }
      await post('tax-in')

      const moved = await asAdminA()
        .patch(ApiRoutes.finance.taxRates.byId(rate.id))
        .send({ inputAccountId: accounts['1301'] })
      expect(moved.status).toBe(CONFLICT)
      expect(errorOf(moved).metadata).toMatchObject({
        conflict: FinanceConflicts.TAX_RATE_ACCOUNT_HAS_HISTORY
      })
      // The other side has no tax on it: each account is looked at on its own
      const output = await asAdminA()
        .patch(ApiRoutes.finance.taxRates.byId(rate.id))
        .send({ outputAccountId: accounts['2101'] })
      expect(output.status).toBe(OK)
      expect(
        (await owner.taxRate.findUniqueOrThrow({ where: { id: rate.id } })).inputAccountId
      ).toBe(accounts['1401'])
      expect(
        (
          await asAdminA()
            .patch(ApiRoutes.finance.taxRates.byId(rate.id))
            .send({ name: 'Still editable' })
        ).status
      ).toBe(OK)
      // An account the rate cannot take is told as such, with or without history
      const invalid = await asAdminA()
        .patch(ApiRoutes.finance.taxRates.byId(rate.id))
        .send({ outputAccountId: accounts['1101'] })
      expect(errorOf(invalid).metadata).not.toMatchObject({
        conflict: FinanceConflicts.TAX_RATE_ACCOUNT_HAS_HISTORY
      })

      // The tax is taken back by another entry: it nets to zero and the accounts move
      await post('tax-back')
      const free = await asAdminA()
        .patch(ApiRoutes.finance.taxRates.byId(rate.id))
        .send({ inputAccountId: accounts['1301'] })
      expect(free.status).toBe(OK)
    })

    it('moves the default to the rate chosen, so there is never more than one', async () => {
      const rate = await createRate()
      const made = await asAdminA()
        .patch(ApiRoutes.finance.taxRates.byId(rate.id))
        .send({ isDefault: true })
      const rates = await listRates()

      expect(made.status).toBe(OK)
      expect(rates.filter(row => row.isDefault).map(row => row.id)).toEqual([rate.id])
      // Put the default back where the other tests expect it
      const vat = rates.find(row => row.code === 'IVA')
      await asAdminA()
        .patch(ApiRoutes.finance.taxRates.byId(vat?.id ?? ''))
        .send({ isDefault: true })
    })

    it('does not switch off the default rate, nor one an active product names; it does once the product lets go', async () => {
      const vat = (await listRates()).find(row => row.isDefault)
      const rate = await createRate()
      const product = await createProduct(owner, { storeId: ctx.storeA.id })
      const named = await asAdminA()
        .patch(ApiRoutes.products.byId(product.id))
        .send({ taxRateId: rate.id })
      const blockedByProduct = await asAdminA().post(ApiRoutes.finance.taxRates.deactivate(rate.id))
      const blockedDefault = await asAdminA().post(
        ApiRoutes.finance.taxRates.deactivate(vat?.id ?? '')
      )
      await asAdminA().patch(ApiRoutes.products.byId(product.id)).send({ taxRateId: null })
      const off = await asAdminA().post(ApiRoutes.finance.taxRates.deactivate(rate.id))
      const on = await asAdminA().post(ApiRoutes.finance.taxRates.reactivate(rate.id))

      expect(named.status).toBe(OK)
      expect(blockedByProduct.status).toBe(CONFLICT)
      expect(errorOf(blockedByProduct).metadata).toMatchObject({
        conflict: FinanceConflicts.TAX_RATE_IN_USE_BY_PRODUCT
      })
      expect(blockedDefault.status).toBe(CONFLICT)
      expect(errorOf(blockedDefault).metadata).toMatchObject({
        conflict: FinanceConflicts.TAX_RATE_IS_DEFAULT
      })
      expect(off.body).toMatchObject({ active: false })
      expect(on.body).toMatchObject({ active: true })
    })

    it('cannot make a switched-off rate the default', async () => {
      const rate = await createRate()
      await asAdminA().post(ApiRoutes.finance.taxRates.deactivate(rate.id))
      const made = await asAdminA()
        .patch(ApiRoutes.finance.taxRates.byId(rate.id))
        .send({ isDefault: true })

      expect(made.status).toBe(CONFLICT)
    })
    it('takes an output account that is a liability and an input account that is an asset, and nothing else', async () => {
      const wrongType = await asAdminA()
        .post(ApiRoutes.finance.taxRates.create)
        .send(newRate({ outputAccountId: accounts['1101'] }))
      const same = await asAdminA()
        .post(ApiRoutes.finance.taxRates.create)
        .send(newRate({ outputAccountId: accounts['2201'], inputAccountId: accounts['2201'] }))
      const rate = await createRate()
      const patch = await asAdminA()
        .patch(ApiRoutes.finance.taxRates.byId(rate.id))
        .send({ inputAccountId: accounts['4101'] })

      for (const response of [wrongType, same, patch]) {
        expect(response.status).toBe(CONFLICT)
        expect(errorOf(response).metadata).toMatchObject({
          conflict: FinanceConflicts.TAX_RATE_ACCOUNT_TYPE
        })
      }
    })

    it('leaves one audit row for a switch that changed something, and none for a repeat', async () => {
      const rate = await createRate()
      await asAdminA().post(ApiRoutes.finance.taxRates.deactivate(rate.id))
      await asAdminA().post(ApiRoutes.finance.taxRates.deactivate(rate.id))
      await asAdminA().post(ApiRoutes.finance.taxRates.reactivate(rate.id))
      await asAdminA().post(ApiRoutes.finance.taxRates.reactivate(rate.id))
      // created, deactivated, reactivated
      const found = await waitForAuditEntries(
        owner,
        { action: AuditAction.FINANCE_TAX_RATE_CHANGED, resourceId: rate.id },
        3
      )
      await new Promise(resolve => setTimeout(resolve, 400))
      const total = await owner.auditLog.count({
        where: { action: AuditAction.FINANCE_TAX_RATE_CHANGED, resourceId: rate.id }
      })

      expect(found.length).toBe(3)
      expect(total).toBe(3)
    })

    it('does not switch off a rate an archived product names, so the product cannot come back with a rate that is off', async () => {
      const rate = await createRate()
      const product = await createProduct(owner, { storeId: ctx.storeA.id })
      await asAdminA().patch(ApiRoutes.products.byId(product.id)).send({ taxRateId: rate.id })
      await asAdminA().patch(ApiRoutes.products.byId(product.id)).send({ active: false })
      const off = await asAdminA().post(ApiRoutes.finance.taxRates.deactivate(rate.id))

      expect(off.status).toBe(CONFLICT)
      expect(errorOf(off).metadata).toMatchObject({
        conflict: FinanceConflicts.TAX_RATE_IN_USE_BY_PRODUCT
      })
    })

    it('does not let the account of a rate be switched off, made a header or retyped, and checks the accounts again when a rate is switched on', async () => {
      const output = await asAdminA()
        .post(ApiRoutes.finance.accounts.create)
        .send({ code: code(), name: 'Tax owed', type: 'liability' })
      const outputId = (output.body as { id: string }).id
      const rate = await createRate({ outputAccountId: outputId })
      const off = await asAdminA().post(ApiRoutes.finance.accounts.deactivate(outputId))
      const header = await asAdminA()
        .patch(ApiRoutes.finance.accounts.byId(outputId))
        .send({ isPostable: false })
      await asAdminA().post(ApiRoutes.finance.taxRates.deactivate(rate.id))
      const stillHeld = await asAdminA().post(ApiRoutes.finance.accounts.deactivate(outputId))

      for (const response of [off, header, stillHeld]) {
        expect(response.status).toBe(CONFLICT)
        expect(errorOf(response).metadata).toMatchObject({
          conflict: FinanceConflicts.ACCOUNT_IN_USE_BY_SETTING
        })
      }
      // Whatever got round that (the owner of the database), the switch on checks the accounts again
      await owner.ledgerAccount.update({ where: { id: outputId }, data: { active: false } })
      const on = await asAdminA().post(ApiRoutes.finance.taxRates.reactivate(rate.id))
      expect(on.status).toBe(CONFLICT)
      expect(errorOf(on).code).toBe(ErrorCodes.FINANCE_ACCOUNT_INACTIVE)
    })

    it('says a switched-off rate cannot be the default with its own conflict', async () => {
      const rate = await createRate()
      await asAdminA().post(ApiRoutes.finance.taxRates.deactivate(rate.id))
      const made = await asAdminA()
        .patch(ApiRoutes.finance.taxRates.byId(rate.id))
        .send({ isDefault: true })
      expect(errorOf(made).metadata).toMatchObject({ conflict: FinanceConflicts.TAX_RATE_INACTIVE })
    })
  })

  describe('the permissions', () => {
    it('lets finance:view read the rates and the tax settings of the store and nothing change them', async () => {
      const viewer = await asRole('tax-viewer', [Permissions.FINANCE_VIEW])
      const rate = await createRate()
      const reads = [
        await viewer.get(ApiRoutes.finance.taxRates.list),
        await viewer.get(ApiRoutes.finance.storeTaxSettings)
      ]
      const refused = [
        await viewer.post(ApiRoutes.finance.taxRates.create).send(newRate()),
        await viewer.patch(ApiRoutes.finance.taxRates.byId(rate.id)).send({ name: 'No' }),
        await viewer.post(ApiRoutes.finance.taxRates.deactivate(rate.id)),
        await viewer.post(ApiRoutes.finance.taxRates.reactivate(rate.id)),
        await viewer
          .patch(ApiRoutes.finance.storeTaxSettings)
          .send({ pricesIncludeTax: false, confirmPriceModeChange: true }),
        await viewer.patch(ApiRoutes.finance.settings).send({ taxRounding: 'down' })
      ]

      expect(reads.map(response => response.status)).toEqual([OK, OK])
      expect(refused.map(response => response.status)).toEqual(Array(6).fill(FORBIDDEN))
      expect((await owner.taxRate.findUniqueOrThrow({ where: { id: rate.id } })).name).toBe(
        'A rate'
      )
    })

    it('lets a role with exactly finance:manage_accounts manage rates, and with products:edit set the tax of a product', async () => {
      const manager = await asRole('tax-manager', [
        Permissions.FINANCE_VIEW,
        Permissions.FINANCE_MANAGE_ACCOUNTS,
        Permissions.PRODUCTS_VIEW,
        Permissions.PRODUCTS_EDIT
      ])
      const created = await manager.post(ApiRoutes.finance.taxRates.create).send(newRate())
      const rate = created.body as TaxRateBody
      const renamed = await manager
        .patch(ApiRoutes.finance.taxRates.byId(rate.id))
        .send({ name: 'Mine' })
      const product = await createProduct(owner, { storeId: ctx.storeA.id })
      const taxed = await manager
        .patch(ApiRoutes.products.byId(product.id))
        .send({ taxTreatment: TaxTreatment.EXEMPT })

      expect([created.status, renamed.status, taxed.status]).toEqual([CREATED, OK, OK])
    })

    it('does not let a role without finance:view read the rates', async () => {
      const nobody = await asRole('tax-nobody', [Permissions.PRODUCTS_VIEW])
      expect((await nobody.get(ApiRoutes.finance.taxRates.list)).status).toBe(FORBIDDEN)
    })
  })

  describe('the settings of the books', () => {
    it('changes the rounding and whether the shipping carries tax, and audits both', async () => {
      const changed = await asAdminA()
        .patch(ApiRoutes.finance.settings)
        .send({ taxRounding: TaxRounding.HALF_EVEN, shippingTaxed: false })
      const bad = await asAdminA().patch(ApiRoutes.finance.settings).send({ taxRounding: 'banker' })
      expect(changed.status).toBe(OK)
      expect(changed.body).toMatchObject({ taxRounding: 'half_even', shippingTaxed: false })
      expect(bad.status).toBe(BAD_REQUEST)
      const found = await waitForAuditEntries(owner, {
        organizationId: ctx.orgA.id,
        action: AuditAction.FINANCE_SETTINGS_CHANGED,
        resourceId: ctx.orgA.id
      })
      expect(found.map(row => row.metadata)).toContainEqual(
        expect.objectContaining({
          changes: {
            taxRounding: { from: 'half_up', to: 'half_even' },
            shippingTaxed: { from: true, to: false }
          }
        })
      )
    })
  })

  describe('the tax of a product', () => {
    it('starts taxed with no rate of its own, and the answer says so', async () => {
      const product = await createProduct(owner, { storeId: ctx.storeA.id })
      const read = await asAdminA().get(ApiRoutes.products.byId(product.id))
      expect(read.body).toMatchObject({ taxTreatment: 'taxed', taxRateId: null })
    })

    it('becomes exempt, drops its rate with it, and the change is audited', async () => {
      const rate = await createRate()
      const product = await createProduct(owner, { storeId: ctx.storeA.id })
      await asAdminA().patch(ApiRoutes.products.byId(product.id)).send({ taxRateId: rate.id })
      const exempt = await asAdminA()
        .patch(ApiRoutes.products.byId(product.id))
        .send({ taxTreatment: TaxTreatment.EXEMPT })

      expect(exempt.status).toBe(OK)
      expect(exempt.body).toMatchObject({ taxTreatment: 'exempt', taxRateId: null })
      const found = await waitForAuditEntries(
        owner,
        { action: AuditAction.PRODUCT_TAX_CHANGED, resourceId: product.id },
        2
      )
      expect(found.map(row => row.metadata)).toContainEqual(
        expect.objectContaining({
          fromTreatment: 'taxed',
          toTreatment: 'exempt',
          fromTaxRateId: rate.id,
          toTaxRateId: null
        })
      )
    })

    it('audits a product made exempt at creation, as it audits the change of one that exists', async () => {
      const created = await asAdminA()
        .post(ApiRoutes.products.create)
        .send({ name: `p-${randomUUID().slice(0, 6)}`, priceCents: 100, taxTreatment: 'exempt' })
      const id = (created.body as { id: string }).id
      const found = await waitForAuditEntries(owner, {
        action: AuditAction.PRODUCT_TAX_CHANGED,
        resourceId: id
      })

      expect(created.status).toBe(CREATED)
      expect(found[0]?.metadata).toMatchObject({ fromTreatment: 'taxed', toTreatment: 'exempt' })
    })

    it('refuses a rate for a product that is not taxed, and one that is switched off', async () => {
      const rate = await createRate()
      const product = await createProduct(owner, { storeId: ctx.storeA.id })
      const contradiction = await asAdminA()
        .patch(ApiRoutes.products.byId(product.id))
        .send({ taxTreatment: TaxTreatment.NOT_SUBJECT, taxRateId: rate.id })
      await asAdminA().post(ApiRoutes.finance.taxRates.deactivate(rate.id))
      const off = await asAdminA()
        .patch(ApiRoutes.products.byId(product.id))
        .send({ taxRateId: rate.id })

      expect(contradiction.status).toBe(BAD_REQUEST)
      expect(off.status).toBe(CONFLICT)
      expect(errorOf(off).metadata).toMatchObject({ conflict: ProductConflicts.TAX_RATE_INACTIVE })
    })

    it('takes the rate of another organization for a rate that does not exist, on create and on update', async () => {
      const theirs = await createRateOfOrganizationB()
      const product = await createProduct(owner, { storeId: ctx.storeA.id })
      const update = await asAdminA()
        .patch(ApiRoutes.products.byId(product.id))
        .send({ taxRateId: theirs })
      const create = await asAdminA()
        .post(ApiRoutes.products.create)
        .send({ name: `p-${randomUUID().slice(0, 6)}`, priceCents: 100, taxRateId: theirs })

      expect(update.status).toBe(NOT_FOUND)
      expect(create.status).toBe(NOT_FOUND)
      expect(
        (await owner.product.findUniqueOrThrow({ where: { id: product.id } })).taxRateId
      ).toBeNull()
    })

    it('needs finance:manage_accounts to set it, on top of the permission to edit the product', async () => {
      const editor = await asRole('tax-editor', [
        Permissions.PRODUCTS_VIEW,
        Permissions.PRODUCTS_EDIT,
        Permissions.PRODUCTS_CREATE
      ])
      const product = await createProduct(owner, { storeId: ctx.storeA.id })
      const treatment = await editor
        .patch(ApiRoutes.products.byId(product.id))
        .send({ taxTreatment: TaxTreatment.EXEMPT })
      const rate = await editor.patch(ApiRoutes.products.byId(product.id)).send({ taxRateId: null })
      const create = await editor
        .post(ApiRoutes.products.create)
        .send({ name: `p-${randomUUID().slice(0, 6)}`, priceCents: 100, taxTreatment: 'exempt' })
      const plain = await editor
        .patch(ApiRoutes.products.byId(product.id))
        .send({ name: 'Renamed' })

      expect([treatment.status, rate.status, create.status]).toEqual([
        FORBIDDEN,
        FORBIDDEN,
        FORBIDDEN
      ])
      expect(plain.status).toBe(OK)
      expect(
        (await owner.product.findUniqueOrThrow({ where: { id: product.id } })).taxTreatment
      ).toBe('taxed')
    })
  })

  describe('the tax settings of a store', () => {
    it('start with the prices including the tax, change by the finance route and show in the preferences', async () => {
      const before = await asAdminA().get(ApiRoutes.finance.storeTaxSettings)
      const changed = await asAdminA()
        .patch(ApiRoutes.finance.storeTaxSettings)
        .send({ pricesIncludeTax: false, confirmPriceModeChange: true })
      const preferences = await asAdminA().get(ApiRoutes.settings.preferences)

      expect(before.body).toEqual({ pricesIncludeTax: true })
      expect(changed.body).toEqual({ pricesIncludeTax: false })
      expect((preferences.body as { finance: unknown }).finance).toEqual({
        pricesIncludeTax: false
      })
      const found = await waitForAuditEntries(owner, {
        organizationId: ctx.orgA.id,
        action: AuditAction.FINANCE_SETTINGS_CHANGED,
        resourceId: ctx.storeA.id
      })
      expect(found.map(row => row.metadata)).toContainEqual(
        expect.objectContaining({
          changes: { pricesIncludeTax: { from: true, to: false } }
        })
      )
    })

    it('refuse a change of the price mode that nobody confirmed (HC-209)', async () => {
      const unconfirmed = await asAdminA()
        .patch(ApiRoutes.finance.storeTaxSettings)
        .send({ pricesIncludeTax: false })
      const wrongProof = await asAdminA()
        .patch(ApiRoutes.finance.storeTaxSettings)
        .send({ pricesIncludeTax: false, confirmPriceModeChange: false })
      const same = await asAdminA()
        .patch(ApiRoutes.finance.storeTaxSettings)
        .send({ pricesIncludeTax: true })
      const after = await asAdminA().get(ApiRoutes.finance.storeTaxSettings)

      expect(unconfirmed.status).toBe(CONFLICT)
      expect(errorOf(unconfirmed).code).toBe(ErrorCodes.FINANCE_PRICE_MODE_CHANGE_UNCONFIRMED)
      expect(wrongProof.status).toBe(BAD_REQUEST)
      // Saying the mode it already has changes nothing, so nothing is asked
      expect(same.status).toBe(OK)
      expect(after.body).toEqual({ pricesIncludeTax: true })
    })

    it('are not written by the preferences route, which needs another permission', async () => {
      const response = await asAdminA()
        .put(ApiRoutes.settings.preferences)
        .send({ finance: { pricesIncludeTax: true } })
      expect(response.status).toBe(BAD_REQUEST)
      await asAdminA()
        .patch(ApiRoutes.finance.storeTaxSettings)
        .send({ pricesIncludeTax: true, confirmPriceModeChange: true })
    })

    it('belong to the store of the request: another store keeps its own', async () => {
      await asAdminA()
        .patch(ApiRoutes.finance.storeTaxSettings)
        .send({ pricesIncludeTax: false, confirmPriceModeChange: true })
      const other = await api(app, ctx.adminB, ctx.storeB).get(ApiRoutes.finance.storeTaxSettings)
      await asAdminA()
        .patch(ApiRoutes.finance.storeTaxSettings)
        .send({ pricesIncludeTax: true, confirmPriceModeChange: true })

      expect(other.body).toEqual({ pricesIncludeTax: true })
    })
  })

  describe('the database', () => {
    it('holds the same lists as the enums of the code in its CHECKs', async () => {
      const checks = await owner.$queryRaw<{ name: string; def: string }[]>`
        SELECT conname AS name, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname IN ('finance_settings_tax_rounding_check', 'tax_rates_kind_check', 'products_tax_treatment_check')`
      const listOf = (name: string): string[] =>
        [...(checks.find(row => row.name === name)?.def.matchAll(/'([a-z_]+)'/g) ?? [])]
          .map(match => match[1] as string)
          .sort()

      expect(listOf('finance_settings_tax_rounding_check')).toEqual(
        Object.values(TaxRounding).sort()
      )
      expect(listOf('tax_rates_kind_check')).toEqual(Object.values(TaxKind).sort())
      expect(listOf('products_tax_treatment_check')).toEqual(Object.values(TaxTreatment).sort())
    })

    it('refuses a half-written tax snapshot on an order line, whatever fields are missing', async () => {
      const { itemId } = await createOrder(owner, { storeId: ctx.storeA.id })
      const raw = (treatment: string | null, bps: number | null, cents: number | null) =>
        owner.$executeRawUnsafe(
          `UPDATE order_items SET tax_treatment = $1, tax_rate_bps = $2, tax_cents = $3 WHERE id = $4`,
          treatment,
          bps,
          cents,
          itemId
        )
      await expect(raw('taxed', null, 13)).rejects.toThrow()
      await expect(raw('taxed', 1300, null)).rejects.toThrow()
      await expect(raw('exempt', null, null)).rejects.toThrow()
      await expect(raw('exempt', 1300, 0)).rejects.toThrow()
      await expect(raw(null, 1300, null)).rejects.toThrow()
      await expect(raw('taxed', 1300, 13)).resolves.toBeDefined()
      await expect(raw('exempt', null, 0)).resolves.toBeDefined()
      await expect(raw(null, null, null)).resolves.toBeDefined()
    })

    it('gives the application roles no way to delete or empty the rates, and keeps their other privileges', async () => {
      const has = async (role: string, privilege: string): Promise<boolean> =>
        (
          await owner.$queryRaw<{ allowed: boolean }[]>`
            SELECT has_table_privilege(${role}, 'tax_rates', ${privilege}) AS allowed`
        )[0]?.allowed === true

      for (const role of ['platform_app', 'platform_worker']) {
        expect(await has(role, 'DELETE')).toBe(false)
        expect(await has(role, 'TRUNCATE')).toBe(false)
        expect(await has(role, 'SELECT')).toBe(true)
        expect(await has(role, 'INSERT')).toBe(true)
        expect(await has(role, 'UPDATE')).toBe(true)
      }
    })

    it('refuses a product that names the rate of another organization, whatever wrote it', async () => {
      const theirs = await createRateOfOrganizationB()
      const product = await createProduct(owner, { storeId: ctx.storeA.id })
      await expect(
        owner.product.update({ where: { id: product.id }, data: { taxRateId: theirs } })
      ).rejects.toThrow(/FINANCE_TAX_RATE_FOREIGN/)
    })

    it('refuses, in the database, a rate for a product that is not taxed and a treatment that is not one', async () => {
      const rate = await createRate()
      const product = await createProduct(owner, { storeId: ctx.storeA.id })
      await expect(
        owner.product.update({
          where: { id: product.id },
          data: { taxTreatment: 'exempt', taxRateId: rate.id }
        })
      ).rejects.toThrow(/products_tax_rate_taxed_check/)
      await expect(
        owner.product.update({ where: { id: product.id }, data: { taxTreatment: 'other' } })
      ).rejects.toThrow(/products_tax_treatment_check/)
    })
  })

  // The books of organization B, set up once as the owner of the database: B is not set up through the api in this suite
  let booksB: Promise<FinanceFixture> | null = null
  const booksOfB = (): Promise<FinanceFixture> =>
    (booksB ??= createFinanceFixture(owner, ctx.orgB.id))

  async function createRateOfOrganizationB(): Promise<string> {
    const books = await booksOfB()
    const created = await owner.taxRate.create({
      data: {
        organizationId: ctx.orgB.id,
        code: code(),
        name: 'Theirs',
        rateBps: 900,
        outputAccountId: books.accounts.liability,
        inputAccountId: books.accounts.cash
      },
      select: { id: true }
    })
    return created.id
  }
})
