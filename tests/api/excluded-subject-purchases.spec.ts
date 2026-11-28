import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { Permissions } from '@platform/core/auth'
import { CredentialCipher } from '@platform/core/crypto'
import { DatabaseRoles, type OwnerClient } from '@platform/core/database-testing'
import {
  ExcludedSubjectConflicts,
  ExcludedSubjectProblems,
  FiscalEnvironment,
  FiscalIssueOn
} from '@platform/core/domain'
import { FiscalProviderRegistry } from '@platform/fiscal/runtime'
import { SIMULATOR_PROVIDER_ID } from '@platform/fiscal/simulator'

import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

interface ErrorBody {
  error: { code: string; metadata?: Record<string, unknown> }
}
interface PurchaseBody {
  id: string
  purchasedOn: string
  seller: { documentType: string; nameMasked: string | null; documentMasked: string | null }
  documentSeries: string | null
  generationCode: string | null
  amountCents: number
  vatWithheldCents: number
  incomeTaxWithheldCents: number
  lines: { lineNo: number; kind: string; amountCents: number }[]
}
interface PageBody {
  data: PurchaseBody[]
  hasMore: boolean
}

const OK = 200
const CREATED = 201
const BAD_REQUEST = 400
const FORBIDDEN = 403
const NOT_FOUND = 404
const CONFLICT = 409

const SELLER = { documentType: '2', documentNumber: '012345678', name: 'Maria Vendedora Perez' }
const CLASSIFICATION = { operationType: '1', expenseClass: '2', sector: '2', costType: '1' }

describe('Purchases from an excluded subject (D20b)', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
  })
  afterAll(async () => {
    jest.restoreAllMocks()
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const asAdminA = () => api(app, ctx.adminA, ctx.storeA)
  const asAdminB = () => api(app, ctx.adminB, ctx.storeB)
  const errorOf = (response: { body: unknown }) => (response.body as ErrorBody).error
  const key = (): string => `k${randomUUID().replaceAll('-', '')}`
  const body = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    idempotencyKey: key(),
    purchasedOn: new Date().toISOString().slice(0, 10),
    seller: SELLER,
    ...CLASSIFICATION,
    lines: [{ description: 'transport of goods', kind: 'service', amountCents: 20_000 }],
    ...extra
  })
  const record = (extra: Record<string, unknown> = {}, who = asAdminA()) =>
    who.post(ApiRoutes.excludedSubjectPurchases.create).send(body(extra))

  describe('the income tax withheld (articles 154 and 156 of the Tax Code)', () => {
    it('withholds nothing on goods, ten per cent on a service and on the services of a mixed purchase', async () => {
      const goods = await record({
        lines: [{ description: 'baskets', kind: 'goods', amountCents: 50_000 }]
      })
      expect(goods.status).toBe(CREATED)
      expect((goods.body as PurchaseBody).incomeTaxWithheldCents).toBe(0)

      const service = await record()
      expect((service.body as PurchaseBody).incomeTaxWithheldCents).toBe(2_000)

      const mixed = await record({
        lines: [
          { description: 'baskets', kind: 'goods', amountCents: 10_005 },
          { description: 'delivery', kind: 'service', amountCents: 1_005 }
        ]
      })
      const made = mixed.body as PurchaseBody
      expect(made.amountCents).toBe(11_010)
      // 10 % of 10.05 is 1.005: half a cent goes up
      expect(made.incomeTaxWithheldCents).toBe(101)
      const row = await owner.excludedSubjectPurchase.findUniqueOrThrow({ where: { id: made.id } })
      expect(row.incomeTaxWithheldCents).toBe(101)
    })

    it('refuses a figure for the income tax in the request: it is computed, never stated', async () => {
      const refused = await record({ incomeTaxWithheldCents: 0 })
      expect(refused.status).toBe(BAD_REQUEST)
      const before = await owner.excludedSubjectPurchase.count({
        where: { organizationId: ctx.orgA.id }
      })
      const other = await record({ withheldIncomeTax: 1 })
      expect(other.status).toBe(BAD_REQUEST)
      expect(
        await owner.excludedSubjectPurchase.count({ where: { organizationId: ctx.orgA.id } })
      ).toBe(before)
    })
  })

  describe('writing and reading', () => {
    it('shows the seller masked, keeps the person out of the audit trail and takes the organization from the guard', async () => {
      const made = await record({ organizationId: ctx.orgB.id })
      // A field the schema does not know is refused, so an organization in the body is not even looked at
      expect(made.status).toBe(BAD_REQUEST)
      const ok = await record()
      expect(ok.status).toBe(CREATED)
      const created = ok.body as PurchaseBody
      expect(JSON.stringify(created)).not.toContain(SELLER.name)
      expect(JSON.stringify(created)).not.toContain(SELLER.documentNumber)
      expect(created.seller.nameMasked).toBe('M***********')
      const row = await owner.excludedSubjectPurchase.findUniqueOrThrow({
        where: { id: created.id }
      })
      expect(row.organizationId).toBe(ctx.orgA.id)
      // Sealed: neither the name nor the document is in the row, in the clear
      const bytes = Buffer.from(row.sellerEncrypted)
      expect(bytes.includes(SELLER.name)).toBe(false)
      expect(bytes.includes(SELLER.documentNumber)).toBe(false)
      expect(app.get(CredentialCipher).open(row.sellerEncrypted)).toEqual({
        documentNumber: SELLER.documentNumber,
        name: SELLER.name
      })

      const [entry] = await waitForAuditEntries(owner, {
        action: AuditAction.EXCLUDED_SUBJECT_PURCHASE_RECORDED,
        resourceId: created.id
      })
      expect(entry).toBeDefined()
      const trail = JSON.stringify(entry?.metadata)
      expect(trail).not.toContain(SELLER.name)
      expect(trail).not.toContain(SELLER.documentNumber)
      expect(entry?.metadata).toMatchObject({ amountCents: 20_000, incomeTaxWithheldCents: 2_000 })

      const read = await asAdminA().get(ApiRoutes.excludedSubjectPurchases.byId(created.id))
      expect(read.status).toBe(OK)
      expect(JSON.stringify(read.body)).not.toContain(SELLER.documentNumber)
      const list = await asAdminA().get(ApiRoutes.excludedSubjectPurchases.list)
      expect(list.status).toBe(OK)
      expect((list.body as PageBody).data.some(item => item.id === created.id)).toBe(true)
    })

    it('treats the same key with the same content as the same request, and refuses it with another content', async () => {
      const sent = body()
      const first = await asAdminA().post(ApiRoutes.excludedSubjectPurchases.create).send(sent)
      const again = await asAdminA().post(ApiRoutes.excludedSubjectPurchases.create).send(sent)
      expect(first.status).toBe(CREATED)
      expect(again.status).toBe(CREATED)
      expect((again.body as PurchaseBody).id).toBe((first.body as PurchaseBody).id)
      expect(
        await owner.excludedSubjectPurchase.count({
          where: { organizationId: ctx.orgA.id, clientKey: String(sent.idempotencyKey) }
        })
      ).toBe(1)
      // The record is written once and the replay writes nothing more: wait for the first row, then count what the replay left
      const id = (first.body as PurchaseBody).id
      await waitForAuditEntries(owner, {
        action: AuditAction.EXCLUDED_SUBJECT_PURCHASE_RECORDED,
        resourceId: id
      })
      await asAdminA().post(ApiRoutes.excludedSubjectPurchases.create).send(sent)
      await new Promise(resolve => setTimeout(resolve, 300))
      expect(
        await owner.auditLog.count({
          where: { action: AuditAction.EXCLUDED_SUBJECT_PURCHASE_RECORDED, resourceId: id }
        })
      ).toBe(1)

      const other = await asAdminA()
        .post(ApiRoutes.excludedSubjectPurchases.create)
        .send({
          ...sent,
          lines: [{ description: 'another', kind: 'goods', amountCents: 1 }]
        })
      expect(other.status).toBe(CONFLICT)
      expect(errorOf(other).metadata).toMatchObject({
        conflict: ExcludedSubjectConflicts.KEY_REUSED
      })
    })

    it('takes an electronic invoice once per organization, in capitals or not', async () => {
      const code = randomUUID()
      const first = await record({ documentSeries: '2026ABCDEF', generationCode: code })
      expect(first.status).toBe(CREATED)
      expect((first.body as PurchaseBody).generationCode).toBe(code.toUpperCase())
      const second = await record({
        documentSeries: '2026ABCDEF',
        generationCode: code.toUpperCase()
      })
      expect(second.status).toBe(CONFLICT)
      expect(errorOf(second).metadata).toMatchObject({
        conflict: ExcludedSubjectConflicts.GENERATION_CODE_IN_USE
      })
      // The series without the code is refused by the body
      expect((await record({ documentSeries: 'X' })).status).toBe(BAD_REQUEST)
    })

    it('refuses a day that has not come', async () => {
      const tomorrow = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10)
      const refused = await record({ purchasedOn: tomorrow })
      expect(refused.status).toBe(BAD_REQUEST)
      expect(errorOf(refused).metadata).toMatchObject({
        problems: [ExcludedSubjectProblems.PURCHASED_IN_THE_FUTURE]
      })
    })
  })

  describe('who reaches them', () => {
    it('asks for the permission that manages purchases, on every route', async () => {
      const reader = api(
        app,
        await actorWithPermissions(owner, app, {
          prefix,
          name: 'excluded-reader',
          organizationId: ctx.orgA.id,
          storeId: ctx.storeA.id,
          permissions: [Permissions.FINANCE_VIEW]
        }),
        ctx.storeA
      )
      const made = (await record()).body as PurchaseBody
      const attempts = [
        await reader.post(ApiRoutes.excludedSubjectPurchases.create).send(body()),
        await reader.get(ApiRoutes.excludedSubjectPurchases.list),
        await reader.get(ApiRoutes.excludedSubjectPurchases.byId(made.id))
      ]
      expect(attempts.map(attempt => attempt.status)).toEqual([FORBIDDEN, FORBIDDEN, FORBIDDEN])
    })

    it('does not show a purchase of one organization to another, nor write it there', async () => {
      const made = (await record()).body as PurchaseBody
      const foreign = await asAdminB().get(ApiRoutes.excludedSubjectPurchases.byId(made.id))
      expect(foreign.status).toBe(NOT_FOUND)
      const list = await asAdminB().get(ApiRoutes.excludedSubjectPurchases.list)
      expect((list.body as PageBody).data.map(item => item.id)).not.toContain(made.id)
      const own = (await record({}, asAdminB())).body as PurchaseBody
      const row = await owner.excludedSubjectPurchase.findUniqueOrThrow({ where: { id: own.id } })
      expect(row.organizationId).toBe(ctx.orgB.id)
    })
  })

  describe('the database', () => {
    it('never changes or deletes a purchase or its concepts, even for the owner', async () => {
      const made = (await record()).body as PurchaseBody
      await expect(
        owner.$executeRawUnsafe(
          `UPDATE excluded_subject_purchases SET amount_cents = 1 WHERE id = '${made.id}'`
        )
      ).rejects.toThrow(/EXCLUDED_SUBJECT_IMMUTABLE/)
      await expect(
        owner.$executeRawUnsafe(
          `DELETE FROM excluded_subject_purchase_lines WHERE purchase_id = '${made.id}'`
        )
      ).rejects.toThrow(/EXCLUDED_SUBJECT_IMMUTABLE/)
      await expect(
        owner.$executeRawUnsafe('TRUNCATE excluded_subject_purchases CASCADE')
      ).rejects.toThrow(/EXCLUDED_SUBJECT_IMMUTABLE/)
    })

    it('writes the amount as the sum of the concepts, or nothing', async () => {
      const id = randomUUID()
      // One statement: the header and a concept that does not add up to it; the check runs when it commits
      await expect(
        owner.$executeRawUnsafe(
          `WITH header AS (
             INSERT INTO excluded_subject_purchases (id, organization_id, client_key, purchased_on, seller_document_type, seller_encrypted, amount_cents, vat_withheld_cents, income_tax_withheld_cents, operation_type, expense_class, sector, cost_type, created_by)
             VALUES ('${id}', '${ctx.orgA.id}', '${key()}', '2026-11-01', '2', decode('01' || repeat('00', 40), 'hex'), 1000, 0, 0, '1', '2', '2', '1', 'suite')
             RETURNING id, organization_id)
           INSERT INTO excluded_subject_purchase_lines (id, organization_id, purchase_id, line_no, description, kind, amount_cents)
           SELECT '${randomUUID()}', organization_id, id, 1, 'x', 'goods', 900 FROM header`
        )
      ).rejects.toThrow(/EXCLUDED_SUBJECT_TOTAL/)
      expect(await owner.excludedSubjectPurchase.count({ where: { id } })).toBe(0)
    })

    it('refuses a concept added to a purchase that was already written', async () => {
      const made = (await record()).body as PurchaseBody
      await expect(
        owner.$executeRawUnsafe(
          `INSERT INTO excluded_subject_purchase_lines (id, organization_id, purchase_id, line_no, description, kind, amount_cents)
           VALUES ('${randomUUID()}', '${ctx.orgA.id}', '${made.id}', 2, 'late', 'goods', 500)`
        )
      ).rejects.toThrow(/EXCLUDED_SUBJECT_TOTAL/)
      expect(
        await owner.excludedSubjectPurchaseLine.count({ where: { purchaseId: made.id } })
      ).toBe(1)
    })

    it('has no default for the income tax withheld: a row that does not say it is not written', async () => {
      await expect(
        owner.$executeRawUnsafe(
          `INSERT INTO excluded_subject_purchases (id, organization_id, client_key, purchased_on, seller_document_type, seller_encrypted, amount_cents, vat_withheld_cents, operation_type, expense_class, sector, cost_type, created_by)
           VALUES ('${randomUUID()}', '${ctx.orgA.id}', '${key()}', '2026-11-01', '2', decode('01' || repeat('00', 40), 'hex'), 1000, 0, '1', '2', '2', '1', 'suite')`
        )
      ).rejects.toThrow(/income_tax_withheld_cents/)
    })

    it('lets the application add and read, and the worker only read', async () => {
      const has = async (role: string, table: string, privilege: string): Promise<boolean> =>
        (
          await owner.$queryRaw<{ allowed: boolean }[]>`
            SELECT has_table_privilege(${role}, ${table}, ${privilege}) AS allowed`
        )[0]?.allowed === true
      for (const table of ['excluded_subject_purchases', 'excluded_subject_purchase_lines']) {
        expect(await has(DatabaseRoles.APP, table, 'SELECT')).toBe(true)
        expect(await has(DatabaseRoles.APP, table, 'INSERT')).toBe(true)
        expect(await has(DatabaseRoles.WORKER, table, 'SELECT')).toBe(true)
        for (const privilege of ['UPDATE', 'DELETE', 'TRUNCATE']) {
          expect(await has(DatabaseRoles.APP, table, privilege)).toBe(false)
          expect(await has(DatabaseRoles.WORKER, table, privilege)).toBe(false)
        }
        expect(await has(DatabaseRoles.WORKER, table, 'INSERT')).toBe(false)
      }
    })
  })

  describe('the rules of the provider', () => {
    // A provider that has a rule for these purchases: it finds the VAT withheld wrong when it is 77 cents
    beforeAll(() => {
      const registry = app.get(FiscalProviderRegistry)
      const real = registry.find.bind(registry)
      jest.spyOn(registry, 'find').mockImplementation(id => {
        const provider = real(id)
        return provider === undefined || provider.id !== SIMULATOR_PROVIDER_ID
          ? provider
          : (Object.create(provider, {
              validateExcludedSubjectPurchase: {
                value: (input: { vatWithheldCents: number }) =>
                  input.vatWithheldCents === 77
                    ? [ExcludedSubjectProblems.VAT_WITHHELD_INVALID]
                    : []
              }
            }) as typeof provider)
      })
    })

    it('accepts what was written while the organization has no issuer, and checks it once it has one', async () => {
      const before = await record({ vatWithheldCents: 77 })
      expect(before.status).toBe(CREATED)
      const issuer = await asAdminA()
        .put(ApiRoutes.fiscal.issuer)
        .send({
          providerId: SIMULATOR_PROVIDER_ID,
          legalName: 'Excluded Issuer',
          taxId: 'EX-ISSUER',
          address: { line1: 'x' },
          environment: FiscalEnvironment.SANDBOX,
          issueOn: FiscalIssueOn.DELIVERED,
          credentials: { signingKey: 'not-a-real-signing-key-1234567890' }
        })
      expect(issuer.status).toBe(OK)
      const refused = await record({ vatWithheldCents: 77 })
      expect(refused.status).toBe(BAD_REQUEST)
      expect(errorOf(refused).metadata).toMatchObject({
        problems: [ExcludedSubjectProblems.VAT_WITHHELD_INVALID]
      })
      expect(JSON.stringify(refused.body)).not.toContain(SELLER.documentNumber)
      expect((await record({ vatWithheldCents: 0 })).status).toBe(CREATED)
    })
  })
})
