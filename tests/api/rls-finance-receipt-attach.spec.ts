import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { Permissions } from '@platform/core/auth'
import { PrismaService, RLS_CONTEXT_ENABLED } from '@platform/core/database'
import { connectionUrls, type OwnerClient } from '@platform/core/database-testing'
import {
  FinanceConflicts,
  FinanceCountryCodes,
  FinanceTransactionKind
} from '@platform/core/domain'

import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { type Actor, api } from '../helpers/http'

interface ErrorBody {
  error: { code: string; metadata?: Record<string, unknown> }
}
interface TransactionBody {
  id: string
  documentMediaId: string | null
}

const CREATED = 201
const FORBIDDEN = 403
const NOT_FOUND = 404
const CONFLICT = 409
const CASH = '1101'
const SERVICES = '6106'
const TODAY = new Date().toISOString().slice(0, 10)

// The books belong to the organization and a file to ONE store. With the switch ON the request of store A2 sees the rows of A2 alone,
// and the trigger of the link (`check_finance_transaction_row`, not SECURITY DEFINER) reads the file under the same row policy, so the
// receipt of a file uploaded in A1 must be attached in a context that holds the store that owns it. The app below is the real one, on
// the role of the api, with the switch on and a context required for every query.
describe('RLS phase 6: the receipt of a file uploaded in a sibling store', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let guarded: PrismaService
  let owner: OwnerClient
  let ctx: TestContext
  let accounts: Record<string, string> = {}
  let readerA2: Actor

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
    const setup = await api(app, ctx.adminA, ctx.storeA)
      .post(ApiRoutes.finance.setup)
      .send({ countryCode: FinanceCountryCodes.EL_SALVADOR, accountingStartDate: '2020-01-01' })
    expect(setup.status).toBe(CREATED)
    const rows = await owner.ledgerAccount.findMany({
      where: { organizationId: ctx.orgA.id },
      select: { id: true, code: true }
    })
    accounts = Object.fromEntries(rows.map(row => [row.code, row.id]))
    readerA2 = await actorWithPermissions(owner, app, {
      prefix,
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA2.id,
      name: 'readerA2',
      permissions: [Permissions.MEDIA_VIEW, Permissions.FINANCE_VIEW_JOURNAL]
    })
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await guarded.onModuleDestroy()
    await owner.$disconnect()
  })

  const registered = async (): Promise<TransactionBody> => {
    const response = await api(app, ctx.adminA, ctx.storeA)
      .post(ApiRoutes.finance.transactions.record)
      .send({
        idempotencyKey: `k${randomUUID().replaceAll('-', '')}`,
        kind: FinanceTransactionKind.EXPENSE,
        occurredOn: TODAY,
        amountCents: 5000,
        fromAccountId: accounts[CASH],
        categoryAccountId: accounts[SERVICES]
      })
    expect(response.status).toBe(CREATED)
    return response.body as TransactionBody
  }
  // A file the pipeline already found clean, made for a transaction (a row the owner writes: the upload itself is tested elsewhere)
  async function receipt(
    transactionId: string,
    options: { storeId?: string; status?: string; purpose?: string } = {}
  ): Promise<string> {
    const id = randomUUID()
    await owner.media.create({
      data: {
        id,
        storeId: options.storeId ?? ctx.storeA.id,
        purpose: options.purpose ?? 'finance_document',
        // Only a receipt has a parent transaction (chk_media_finance_parent)
        financeTransactionId:
          (options.purpose ?? 'finance_document') === 'finance_document' ? transactionId : null,
        key: `${prefix}/finance-document/${id}`,
        filename: 'receipt.png',
        contentType: 'image/png',
        fileSize: 1,
        status: options.status ?? 'clean'
      }
    })
    return id
  }
  const attach = (actor: Actor, store: { id: string }, transactionId: string, mediaId: string) =>
    api(app, actor, store)
      .post(ApiRoutes.finance.transactions.document(transactionId))
      .send({ mediaId })
  const documentOf = async (id: string) =>
    (await owner.financeTransaction.findUniqueOrThrow({ where: { id } })).documentMediaId
  const auditCount = (resourceId: string) =>
    owner.auditLog.count({
      where: { action: AuditAction.FINANCE_TRANSACTION_DOCUMENT_ATTACHED, resourceId }
    })

  it('attaches a file uploaded in store A1 from store A2, with the same answer as in A1', async () => {
    const target = await registered()
    const mediaId = await receipt(target.id)
    const response = await attach(ctx.adminA2, ctx.storeA2, target.id, mediaId)
    expect(response.status).toBe(CREATED)
    expect((response.body as TransactionBody).documentMediaId).toBe(mediaId)
    expect(await documentOf(target.id)).toBe(mediaId)
    // The same file again, from either store, is the same request: nothing is written twice
    expect((await attach(ctx.adminA2, ctx.storeA2, target.id, mediaId)).status).toBe(CREATED)
    expect((await attach(ctx.adminA, ctx.storeA, target.id, mediaId)).status).toBe(CREATED)
    await waitForAuditEntries(owner, {
      action: AuditAction.FINANCE_TRANSACTION_DOCUMENT_ATTACHED,
      resourceId: target.id
    })
    expect(await auditCount(target.id)).toBe(1)
  })

  it('waits for the scan of a file of another store: one 409, and nothing is written', async () => {
    const target = await registered()
    const mediaId = await receipt(target.id, { status: 'pending' })
    const response = await attach(ctx.adminA2, ctx.storeA2, target.id, mediaId)
    expect(response.status).toBe(CONFLICT)
    expect(((response.body as ErrorBody).error.metadata as { conflict?: string }).conflict).toBe(
      FinanceConflicts.TRANSACTION_DOCUMENT_NOT_CLEAN
    )
    expect(await documentOf(target.id)).toBeNull()
  })

  it('gives one and the same 404 for a file of another transaction, another purpose, another organization or none, from A2', async () => {
    const target = await registered()
    const other = await registered()
    const ofOther = await receipt(other.id)
    const foreignPurpose = await receipt(target.id, { purpose: 'message' })
    // A file of ANOTHER organization made for this very transaction (written by the owner: the pipeline would not)
    const foreignOrg = await receipt(target.id, { storeId: ctx.storeB.id })
    const answers = []
    for (const mediaId of [ofOther, foreignPurpose, foreignOrg, randomUUID()]) {
      const response = await attach(ctx.adminA2, ctx.storeA2, target.id, mediaId)
      expect(response.status).toBe(NOT_FOUND)
      answers.push((response.body as ErrorBody).error)
    }
    for (const answer of answers.slice(1)) expect(answer).toEqual(answers[0])
    expect(await documentOf(target.id)).toBeNull()
    expect(await auditCount(target.id)).toBe(0)
  })

  it('refuses who may not attach, with nothing written', async () => {
    const target = await registered()
    const mediaId = await receipt(target.id)
    const response = await attach(readerA2, ctx.storeA2, target.id, mediaId)
    expect(response.status).toBe(FORBIDDEN)
    expect(await documentOf(target.id)).toBeNull()
  })

  it('answers two files at once, one from each store, with one receipt and one typed 409', async () => {
    const target = await registered()
    const first = await receipt(target.id)
    const second = await receipt(target.id, { storeId: ctx.storeA2.id })
    const [fromA2, fromA] = await Promise.all([
      attach(ctx.adminA2, ctx.storeA2, target.id, first),
      attach(ctx.adminA, ctx.storeA, target.id, second)
    ])
    const statuses = [fromA2.status, fromA.status].sort()
    expect(statuses).toEqual([CREATED, CONFLICT])
    const loser = fromA2.status === CONFLICT ? fromA2 : fromA
    expect(((loser.body as ErrorBody).error.metadata as { conflict?: string }).conflict).toBe(
      FinanceConflicts.TRANSACTION_DOCUMENT_ALREADY_SET
    )
    expect([first, second]).toContain(await documentOf(target.id))
  })

  it('answers the same file at once from two stores with the one receipt', async () => {
    const target = await registered()
    const mediaId = await receipt(target.id)
    const answers = await Promise.all([
      attach(ctx.adminA2, ctx.storeA2, target.id, mediaId),
      attach(ctx.adminA, ctx.storeA, target.id, mediaId)
    ])
    expect(answers.map(answer => answer.status)).toEqual([CREATED, CREATED])
    expect(await documentOf(target.id)).toBe(mediaId)
  })

  it('races a void: the receipt is attached or the answer is the typed 409, never a 500', async () => {
    const target = await registered()
    const mediaId = await receipt(target.id)
    const [voided, attached] = await Promise.all([
      api(app, ctx.adminA, ctx.storeA)
        .post(ApiRoutes.finance.transactions.void(target.id))
        .send({ reason: 'Gone' }),
      attach(ctx.adminA2, ctx.storeA2, target.id, mediaId)
    ])
    expect(voided.status).toBe(CREATED)
    expect([CREATED, CONFLICT]).toContain(attached.status)
  })
})
