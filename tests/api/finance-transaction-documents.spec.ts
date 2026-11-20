import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { Permissions } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  FinanceConflicts,
  FinanceCountryCodes,
  FinanceResourceTypes,
  FinanceTransactionKind
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { FinanceDocumentUpload, StorageKeys } from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'

import { MediaService } from '../../apps/api/src/modules/media/media.service'
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
  voided: boolean
}
interface UploadUrlBody {
  uploadUrl: string
  key: string
  mediaId: string
}

const OK = 200
const CREATED = 201
const BAD_REQUEST = 400
const FORBIDDEN = 403
const NOT_FOUND = 404
const CONFLICT = 409

// 1x1 transparent PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
)

const CASH = '1101'
const BANK = '111001'
const SERVICES = '6106'
const TODAY = new Date().toISOString().slice(0, 10)

// The receipt of a transaction registered by hand (TDD_18 §2.6, §4.3; Step 4B.4b): a file made FOR a transaction through the media
// pipeline, then tied to it once. The books belong to the organization and a file to a store: nothing crosses organizations.
describe('The receipt of a transaction of the books (Step 4B.4b)', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let accounts: Record<string, string> = {}
  let bookkeeper: Actor
  let treasurer: Actor
  let journalReader: Actor
  let uploaderOnly: Actor
  let expenseA: TransactionBody
  let transferA: TransactionBody
  const mediaIds = new Set<string>()

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    for (const [actor, store] of [
      [ctx.adminA, ctx.storeA],
      [ctx.adminB, ctx.storeB]
    ] as const) {
      const setup = await api(app, actor, store)
        .post(ApiRoutes.finance.setup)
        .send({ countryCode: FinanceCountryCodes.EL_SALVADOR, accountingStartDate: '2020-01-01' })
      expect(setup.status).toBe(CREATED)
    }
    const rows = await owner.ledgerAccount.findMany({
      where: { organizationId: ctx.orgA.id },
      select: { id: true, code: true }
    })
    accounts = Object.fromEntries(rows.map(row => [row.code, row.id]))
    const base = { prefix, organizationId: ctx.orgA.id, storeId: ctx.storeA.id }
    bookkeeper = await actorWithPermissions(owner, app, {
      ...base,
      name: 'bookkeeperA',
      permissions: [
        Permissions.MEDIA_UPLOAD,
        Permissions.MEDIA_VIEW,
        Permissions.FINANCE_VIEW_JOURNAL,
        Permissions.FINANCE_MANAGE_TRANSACTIONS
      ]
    })
    treasurer = await actorWithPermissions(owner, app, {
      ...base,
      name: 'treasurerA',
      permissions: [
        Permissions.MEDIA_UPLOAD,
        Permissions.MEDIA_VIEW,
        Permissions.FINANCE_VIEW_JOURNAL,
        Permissions.FINANCE_MOVE_MONEY
      ]
    })
    journalReader = await actorWithPermissions(owner, app, {
      ...base,
      name: 'journalReaderA',
      permissions: [Permissions.MEDIA_VIEW, Permissions.FINANCE_VIEW_JOURNAL]
    })
    uploaderOnly = await actorWithPermissions(owner, app, {
      ...base,
      name: 'uploaderOnlyFinanceA',
      permissions: [Permissions.MEDIA_UPLOAD, Permissions.FINANCE_VIEW_JOURNAL]
    })
    expenseA = await registered(ctx.adminA, ctx.storeA, expense())
    transferA = await registered(ctx.adminA, ctx.storeA, transfer())
  })
  afterAll(async () => {
    const storage = app.get(StorageService, { strict: false })
    await Promise.all(
      [...mediaIds].flatMap(id => [
        storage.delete(StorageKeys.messageUpload(ctx.storeA.id, id, 'receipt.png')),
        storage.delete(StorageKeys.message(ctx.storeA.id, id, 'receipt.png'))
      ])
    )
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const codeOf = (body: unknown) => (body as ErrorBody).error.code
  const key = (): string => `k${randomUUID().replaceAll('-', '')}`
  const expense = () => ({
    idempotencyKey: key(),
    kind: FinanceTransactionKind.EXPENSE,
    occurredOn: TODAY,
    amountCents: 5000,
    fromAccountId: accounts[CASH],
    categoryAccountId: accounts[SERVICES]
  })
  const transfer = () => ({
    idempotencyKey: key(),
    kind: FinanceTransactionKind.TRANSFER,
    occurredOn: TODAY,
    amountCents: 5000,
    fromAccountId: accounts[CASH],
    toAccountId: accounts[BANK]
  })
  async function registered(
    actor: Actor,
    store: { id: string },
    body: Record<string, unknown>
  ): Promise<TransactionBody> {
    const response = await api(app, actor, store)
      .post(ApiRoutes.finance.transactions.record)
      .send(body)
    expect(response.status).toBe(CREATED)
    return response.body as TransactionBody
  }
  // A file the pipeline already found clean, made for a transaction (a row the owner writes: the upload itself is below)
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
        financeTransactionId: transactionId,
        key: `${prefix}/finance-document/${id}`,
        filename: 'receipt.png',
        contentType: 'image/png',
        fileSize: PNG.length,
        status: options.status ?? 'clean'
      }
    })
    return id
  }
  const attach = (actor: Actor, store: { id: string }, transactionId: string, mediaId: string) =>
    api(app, actor, store)
      .post(ApiRoutes.finance.transactions.document(transactionId))
      .send({ mediaId })

  describe('the upload', () => {
    const body = (overrides: Record<string, unknown> = {}) => ({
      purpose: 'finance_document',
      parentId: expenseA.id,
      filename: 'receipt.png',
      contentType: 'image/png',
      fileSizeBytes: PNG.length,
      ...overrides
    })
    const requestUrl = (actor: Actor, store: { id: string }, overrides = {}) =>
      api(app, actor, store).post(ApiRoutes.media.uploadUrl).send(body(overrides))

    it('is given to who may register a transaction and read the journal, for a transaction of the organization', async () => {
      for (const [actor, parentId] of [
        [bookkeeper, expenseA.id],
        [treasurer, transferA.id]
      ] as const) {
        const response = await requestUrl(actor, ctx.storeA, { parentId })
        expect(response.status).toBe(OK)
        mediaIds.add((response.body as UploadUrlBody).mediaId)
      }
    })

    it('narrows to the kind of the transaction before it signs anything', async () => {
      const toTransfer = await requestUrl(bookkeeper, ctx.storeA, { parentId: transferA.id })
      expect(toTransfer.status).toBe(FORBIDDEN)
      expect(codeOf(toTransfer.body)).toBe(ErrorCodes.PERMISSION_DENIED)
      const toExpense = await requestUrl(treasurer, ctx.storeA)
      expect(toExpense.status).toBe(FORBIDDEN)
    })

    it('is refused for a voided transaction and for one that has its receipt', async () => {
      const voided = await registered(ctx.adminA, ctx.storeA, expense())
      await api(app, ctx.adminA, ctx.storeA)
        .post(ApiRoutes.finance.transactions.void(voided.id))
        .send({ reason: 'Gone' })
      const documented = await registered(ctx.adminA, ctx.storeA, expense())
      await attach(bookkeeper, ctx.storeA, documented.id, await receipt(documented.id))
      for (const parentId of [voided.id, documented.id]) {
        const response = await requestUrl(bookkeeper, ctx.storeA, { parentId })
        expect(response.status).toBe(CONFLICT)
      }
    })

    it('is refused to who may upload but not register, and to who may register but not read the journal', async () => {
      const denied = await requestUrl(uploaderOnly, ctx.storeA)
      expect(denied.status).toBe(FORBIDDEN)
      expect(codeOf(denied.body)).toBe(ErrorCodes.PERMISSION_DENIED)
      const reader = await requestUrl(journalReader, ctx.storeA)
      expect(reader.status).toBe(FORBIDDEN)
    })

    it('answers the same 404 for a transaction of another organization and for one that does not exist', async () => {
      const other = await registered(ctx.adminB, ctx.storeB, {
        idempotencyKey: key(),
        kind: FinanceTransactionKind.TRANSFER,
        occurredOn: TODAY,
        amountCents: 100,
        fromAccountId: (
          await owner.ledgerAccount.findFirstOrThrow({
            where: { organizationId: ctx.orgB.id, code: CASH }
          })
        ).id,
        toAccountId: (
          await owner.ledgerAccount.findFirstOrThrow({
            where: { organizationId: ctx.orgB.id, code: BANK }
          })
        ).id
      })
      const foreign = await requestUrl(bookkeeper, ctx.storeA, { parentId: other.id })
      const missing = await requestUrl(bookkeeper, ctx.storeA, { parentId: randomUUID() })
      expect(foreign.status).toBe(NOT_FOUND)
      expect(missing.status).toBe(NOT_FOUND)
      expect((foreign.body as ErrorBody).error).toEqual((missing.body as ErrorBody).error)
    })

    it('takes a PDF and refuses a gif, a text file and a file over the limit', async () => {
      const pdf = await requestUrl(bookkeeper, ctx.storeA, {
        filename: 'receipt.pdf',
        contentType: 'application/pdf'
      })
      expect(pdf.status).toBe(OK)
      mediaIds.add((pdf.body as UploadUrlBody).mediaId)
      for (const contentType of ['image/gif', 'text/plain', 'text/csv']) {
        const response = await requestUrl(bookkeeper, ctx.storeA, { contentType })
        expect(response.status).toBe(BAD_REQUEST)
        expect(codeOf(response.body)).toBe(ErrorCodes.FILE_TYPE_NOT_ALLOWED)
      }
      const large = await requestUrl(bookkeeper, ctx.storeA, {
        fileSizeBytes: FinanceDocumentUpload.MAX_SIZE_BYTES + 1
      })
      expect(large.status).toBe(BAD_REQUEST)
      expect(codeOf(large.body)).toBe(ErrorCodes.FILE_TOO_LARGE)
    })

    it('keeps the confirmed file as a file of the transaction, in the store of the request, and queues its scan', async () => {
      const signedUrl = await requestUrl(bookkeeper, ctx.storeA)
      const upload = signedUrl.body as UploadUrlBody
      mediaIds.add(upload.mediaId)
      expect(
        (
          await fetch(upload.uploadUrl, {
            method: 'PUT',
            headers: { 'content-type': 'image/png', 'content-length': String(PNG.length) },
            body: new Uint8Array(PNG)
          })
        ).status
      ).toBe(OK)
      const confirmed = await api(app, bookkeeper, ctx.storeA)
        .post(ApiRoutes.media.confirmUpload)
        .send({ ...body(), mediaId: upload.mediaId, key: upload.key })
      expect(confirmed.status).toBe(OK)
      const row = await owner.media.findUniqueOrThrow({
        where: { id: upload.mediaId },
        select: {
          storeId: true,
          purpose: true,
          financeTransactionId: true,
          orderId: true,
          status: true
        }
      })
      expect(row).toEqual({
        storeId: ctx.storeA.id,
        purpose: 'finance_document',
        financeTransactionId: expenseA.id,
        orderId: null,
        status: 'pending'
      })
      // A confirmation that names another transaction is not the file that was kept
      const moved = await api(app, bookkeeper, ctx.storeA)
        .post(ApiRoutes.media.confirmUpload)
        .send({ ...body({ parentId: transferA.id }), mediaId: upload.mediaId, key: upload.key })
      expect(moved.status).toBe(BAD_REQUEST)
      expect(codeOf(moved.body)).toBe(ErrorCodes.FILE_UPLOAD_FAILED)
    })

    it('checks the transaction again at the confirmation: voided after the signed url is a conflict', async () => {
      const target = await registered(ctx.adminA, ctx.storeA, expense())
      const signedUrl = await requestUrl(bookkeeper, ctx.storeA, { parentId: target.id })
      const upload = signedUrl.body as UploadUrlBody
      mediaIds.add(upload.mediaId)
      await fetch(upload.uploadUrl, {
        method: 'PUT',
        headers: { 'content-type': 'image/png', 'content-length': String(PNG.length) },
        body: new Uint8Array(PNG)
      })
      await api(app, ctx.adminA, ctx.storeA)
        .post(ApiRoutes.finance.transactions.void(target.id))
        .send({ reason: 'Gone' })
      const confirmed = await api(app, bookkeeper, ctx.storeA)
        .post(ApiRoutes.media.confirmUpload)
        .send({ ...body({ parentId: target.id }), mediaId: upload.mediaId, key: upload.key })
      expect(confirmed.status).toBe(CONFLICT)
      expect(await owner.media.count({ where: { id: upload.mediaId } })).toBe(0)
      // Who lost the permission of the kind between the two calls is refused too
      const denied = await api(app, treasurer, ctx.storeA)
        .post(ApiRoutes.media.confirmUpload)
        .send({ ...body(), mediaId: upload.mediaId, key: upload.key })
      expect(denied.status).toBe(FORBIDDEN)
    })

    it('needs the parentId of the transaction', async () => {
      const missing = await requestUrl(bookkeeper, ctx.storeA, { parentId: undefined })
      expect(missing.status).toBe(BAD_REQUEST)
      expect(codeOf(missing.body)).toBe(ErrorCodes.VALIDATION_FAILED)
    })
  })

  describe('attaching the receipt', () => {
    it('sets it once, answers the transaction with it, and writes an audit row', async () => {
      const target = await registered(ctx.adminA, ctx.storeA, expense())
      const mediaId = await receipt(target.id)
      const response = await attach(bookkeeper, ctx.storeA, target.id, mediaId)
      expect(response.status).toBe(CREATED)
      expect((response.body as TransactionBody).documentMediaId).toBe(mediaId)
      const [audit] = await waitForAuditEntries(owner, {
        action: AuditAction.FINANCE_TRANSACTION_DOCUMENT_ATTACHED,
        resourceId: target.id
      })
      expect(audit).toMatchObject({
        resourceType: FinanceResourceTypes.TRANSACTION,
        organizationId: ctx.orgA.id,
        userId: bookkeeper.id
      })
    })

    it('answers the same file again with the same transaction and writes no second audit row', async () => {
      const target = await registered(ctx.adminA, ctx.storeA, expense())
      const mediaId = await receipt(target.id)
      expect((await attach(bookkeeper, ctx.storeA, target.id, mediaId)).status).toBe(CREATED)
      const again = await attach(bookkeeper, ctx.storeA, target.id, mediaId)
      expect(again.status).toBe(CREATED)
      expect((again.body as TransactionBody).documentMediaId).toBe(mediaId)
      await waitForAuditEntries(owner, {
        action: AuditAction.FINANCE_TRANSACTION_DOCUMENT_ATTACHED,
        resourceId: target.id
      })
      expect(
        await owner.auditLog.count({
          where: {
            action: AuditAction.FINANCE_TRANSACTION_DOCUMENT_ATTACHED,
            resourceId: target.id
          }
        })
      ).toBe(1)
    })

    it('refuses another file for a transaction that has one, with the typed conflict', async () => {
      const target = await registered(ctx.adminA, ctx.storeA, expense())
      const first = await receipt(target.id)
      const second = await receipt(target.id)
      expect((await attach(bookkeeper, ctx.storeA, target.id, first)).status).toBe(CREATED)
      const response = await attach(bookkeeper, ctx.storeA, target.id, second)
      expect(response.status).toBe(CONFLICT)
      expect(((response.body as ErrorBody).error.metadata as { conflict?: string }).conflict).toBe(
        FinanceConflicts.TRANSACTION_DOCUMENT_ALREADY_SET
      )
      expect(
        (await owner.financeTransaction.findUniqueOrThrow({ where: { id: target.id } }))
          .documentMediaId
      ).toBe(first)
    })

    it('refuses a file made for another transaction, another purpose or a file that does not exist: one 404', async () => {
      const target = await registered(ctx.adminA, ctx.storeA, expense())
      const other = await registered(ctx.adminA, ctx.storeA, expense())
      const ofOther = await receipt(other.id)
      const foreignPurpose = randomUUID()
      await owner.media.create({
        data: {
          id: foreignPurpose,
          storeId: ctx.storeA.id,
          purpose: 'message',
          key: `${prefix}/message/${foreignPurpose}`,
          filename: 'x.png',
          contentType: 'image/png',
          fileSize: 1,
          status: 'clean'
        }
      })
      const answers = []
      for (const mediaId of [ofOther, foreignPurpose, randomUUID()]) {
        const response = await attach(bookkeeper, ctx.storeA, target.id, mediaId)
        expect(response.status).toBe(NOT_FOUND)
        answers.push((response.body as ErrorBody).error)
      }
      expect(answers[1]).toEqual(answers[0])
      expect(answers[2]).toEqual(answers[0])
      expect(
        (await owner.financeTransaction.findUniqueOrThrow({ where: { id: target.id } }))
          .documentMediaId
      ).toBeNull()
    })

    it('never takes a file of another organization, and tells it apart from nothing', async () => {
      const target = await registered(ctx.adminA, ctx.storeA, expense())
      // The same transaction id as parent, in a store of ANOTHER organization (written by the owner: the pipeline would not)
      const foreignFile = await owner.media
        .create({
          data: {
            id: randomUUID(),
            storeId: ctx.storeB.id,
            purpose: 'finance_document',
            key: `${prefix}/finance-document/${randomUUID()}`,
            filename: 'receipt.png',
            contentType: 'image/png',
            fileSize: PNG.length,
            status: 'clean',
            financeTransactionId: target.id
          },
          select: { id: true }
        })
        .then(row => row.id)
      const response = await attach(bookkeeper, ctx.storeA, target.id, foreignFile)
      expect(response.status).toBe(NOT_FOUND)
      // The same answer as for a file that does not exist: nothing tells that the id is a file of another organization
      const missing = await attach(bookkeeper, ctx.storeA, target.id, randomUUID())
      expect((response.body as ErrorBody).error).toEqual((missing.body as ErrorBody).error)
      expect(
        (await owner.financeTransaction.findUniqueOrThrow({ where: { id: target.id } }))
          .documentMediaId
      ).toBeNull()
    })

    // The books are the organization's and a file belongs to ONE store: a file uploaded in store A1 is the receipt of a transaction
    // attached from store A2 (the same answer as with the row filter off). Under RLS_CONTEXT the file of A1 is not visible to a
    // request of A2, and the database trigger of the link reads it too, so the write has to run in the context of the store that owns it
    describe('through another store of the organization', () => {
      it('attaches a file uploaded in store A1 from store A2, with the same answer as in A1', async () => {
        const target = await registered(ctx.adminA, ctx.storeA, expense())
        const mediaId = await receipt(target.id, { storeId: ctx.storeA.id })
        const response = await attach(ctx.adminA2, ctx.storeA2, target.id, mediaId)
        expect(response.status).toBe(CREATED)
        expect((response.body as TransactionBody).documentMediaId).toBe(mediaId)
        expect(
          (await owner.financeTransaction.findUniqueOrThrow({ where: { id: target.id } }))
            .documentMediaId
        ).toBe(mediaId)
        // The same file again, from A2, is the same request: nothing is written twice
        const again = await attach(ctx.adminA2, ctx.storeA2, target.id, mediaId)
        expect(again.status).toBe(CREATED)
        await waitForAuditEntries(owner, {
          action: AuditAction.FINANCE_TRANSACTION_DOCUMENT_ATTACHED,
          resourceId: target.id
        })
        expect(
          await owner.auditLog.count({
            where: {
              action: AuditAction.FINANCE_TRANSACTION_DOCUMENT_ATTACHED,
              resourceId: target.id
            }
          })
        ).toBe(1)
      })

      it('still waits for the scan of a file of another store: one 409, and nothing is written', async () => {
        const target = await registered(ctx.adminA, ctx.storeA, expense())
        const mediaId = await receipt(target.id, { storeId: ctx.storeA.id, status: 'pending' })
        const response = await attach(ctx.adminA2, ctx.storeA2, target.id, mediaId)
        expect(response.status).toBe(CONFLICT)
        expect(
          ((response.body as ErrorBody).error.metadata as { conflict?: string }).conflict
        ).toBe(FinanceConflicts.TRANSACTION_DOCUMENT_NOT_CLEAN)
        expect(
          (await owner.financeTransaction.findUniqueOrThrow({ where: { id: target.id } }))
            .documentMediaId
        ).toBeNull()
      })

      it('gives one and the same 404 for a file of another transaction, another purpose, another organization or none, from A2', async () => {
        const target = await registered(ctx.adminA, ctx.storeA, expense())
        const other = await registered(ctx.adminA, ctx.storeA, expense())
        const ofOther = await receipt(other.id, { storeId: ctx.storeA.id })
        const foreignPurpose = await receipt(target.id, {
          storeId: ctx.storeA.id,
          purpose: 'message'
        })
        // A file of ANOTHER organization made for this very transaction (written by the owner: the pipeline would not)
        const foreignOrg = await receipt(target.id, { storeId: ctx.storeB.id })
        const answers = []
        for (const mediaId of [ofOther, foreignPurpose, foreignOrg, randomUUID()]) {
          const response = await attach(ctx.adminA2, ctx.storeA2, target.id, mediaId)
          expect(response.status).toBe(NOT_FOUND)
          answers.push((response.body as ErrorBody).error)
        }
        for (const answer of answers.slice(1)) expect(answer).toEqual(answers[0])
        expect(
          (await owner.financeTransaction.findUniqueOrThrow({ where: { id: target.id } }))
            .documentMediaId
        ).toBeNull()
      })

      it('refuses who may not attach, with nothing written', async () => {
        const target = await registered(ctx.adminA, ctx.storeA, expense())
        const mediaId = await receipt(target.id, { storeId: ctx.storeA.id })
        const reader = await actorWithPermissions(owner, app, {
          prefix,
          organizationId: ctx.orgA.id,
          storeId: ctx.storeA2.id,
          name: 'readerA2',
          permissions: [Permissions.MEDIA_VIEW, Permissions.FINANCE_VIEW_JOURNAL]
        })
        const response = await attach(reader, ctx.storeA2, target.id, mediaId)
        expect(response.status).toBe(FORBIDDEN)
        expect(
          (await owner.financeTransaction.findUniqueOrThrow({ where: { id: target.id } }))
            .documentMediaId
        ).toBeNull()
      })
    })

    it('does not attach to a transaction of another organization', async () => {
      const mine = await receipt(expenseA.id)
      const response = await attach(ctx.adminB, ctx.storeB, expenseA.id, mine)
      expect(response.status).toBe(NOT_FOUND)
    })

    it('narrows to the kind: a bookkeeper does not attach to a transfer, a treasurer does not attach to an expense', async () => {
      const toTransfer = await receipt(transferA.id)
      const denied = await attach(bookkeeper, ctx.storeA, transferA.id, toTransfer)
      expect(denied.status).toBe(FORBIDDEN)
      expect(codeOf(denied.body)).toBe(ErrorCodes.PERMISSION_DENIED)
      const toExpense = await receipt(expenseA.id)
      expect((await attach(treasurer, ctx.storeA, expenseA.id, toExpense)).status).toBe(FORBIDDEN)
      expect((await attach(treasurer, ctx.storeA, transferA.id, toTransfer)).status).toBe(CREATED)
    })

    it('waits for the scan: a file that is pending or infected is not the receipt', async () => {
      const target = await registered(ctx.adminA, ctx.storeA, expense())
      for (const status of ['pending', 'infected', 'unscannable']) {
        const response = await attach(
          bookkeeper,
          ctx.storeA,
          target.id,
          await receipt(target.id, { status })
        )
        expect(response.status).toBe(CONFLICT)
        expect(
          ((response.body as ErrorBody).error.metadata as { conflict?: string }).conflict
        ).toBe(FinanceConflicts.TRANSACTION_DOCUMENT_NOT_CLEAN)
      }
      expect(
        (await owner.financeTransaction.findUniqueOrThrow({ where: { id: target.id } }))
          .documentMediaId
      ).toBeNull()
    })

    it('needs the journal too: who may register but not read it is refused', async () => {
      const writer = await actorWithPermissions(owner, app, {
        prefix,
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        name: 'writerNoJournalA',
        permissions: [Permissions.FINANCE_MANAGE_TRANSACTIONS]
      })
      const target = await registered(ctx.adminA, ctx.storeA, expense())
      const response = await attach(writer, ctx.storeA, target.id, await receipt(target.id))
      expect(response.status).toBe(FORBIDDEN)
    })

    it('does not attach for who only reads the journal', async () => {
      const target = await registered(ctx.adminA, ctx.storeA, expense())
      const mediaId = await receipt(target.id)
      const response = await attach(journalReader, ctx.storeA, target.id, mediaId)
      expect(response.status).toBe(FORBIDDEN)
    })

    it('does not attach to a voided transaction', async () => {
      const target = await registered(ctx.adminA, ctx.storeA, expense())
      const voided = await api(app, ctx.adminA, ctx.storeA)
        .post(ApiRoutes.finance.transactions.void(target.id))
        .send({ reason: 'wrong amount' })
      expect(voided.status).toBe(CREATED)
      const response = await attach(ctx.adminA, ctx.storeA, target.id, await receipt(target.id))
      expect(response.status).toBe(CONFLICT)
      expect(((response.body as ErrorBody).error.metadata as { conflict?: string }).conflict).toBe(
        FinanceConflicts.TRANSACTION_ALREADY_VOIDED
      )
    })

    it('shows the receipt in the list and in the detail of the transaction', async () => {
      const target = await registered(ctx.adminA, ctx.storeA, expense())
      const mediaId = await receipt(target.id)
      await attach(bookkeeper, ctx.storeA, target.id, mediaId)
      const detail = await api(app, journalReader, ctx.storeA).get(
        ApiRoutes.finance.transactions.byId(target.id)
      )
      expect((detail.body as TransactionBody).documentMediaId).toBe(mediaId)
      const list = await api(app, journalReader, ctx.storeA).get(
        `${ApiRoutes.finance.transactions.list}?limit=100`
      )
      const listed = (list.body as { data: TransactionBody[] }).data.find(
        row => row.id === target.id
      )
      expect(listed?.documentMediaId).toBe(mediaId)
    })

    it('answers two requests for the same file at once with the one receipt, and writes one audit row', async () => {
      const target = await registered(ctx.adminA, ctx.storeA, expense())
      const mediaId = await receipt(target.id)
      const answers = await Promise.all([
        attach(bookkeeper, ctx.storeA, target.id, mediaId),
        attach(bookkeeper, ctx.storeA, target.id, mediaId)
      ])
      for (const answer of answers) {
        expect(answer.status).toBe(CREATED)
        expect((answer.body as TransactionBody).documentMediaId).toBe(mediaId)
      }
    })

    it('answers two different files at once with one receipt and one typed conflict, never a 500', async () => {
      const target = await registered(ctx.adminA, ctx.storeA, expense())
      const first = await receipt(target.id)
      const second = await receipt(target.id)
      const answers = await Promise.all([
        attach(bookkeeper, ctx.storeA, target.id, first),
        attach(bookkeeper, ctx.storeA, target.id, second)
      ])
      expect(answers.map(answer => answer.status).sort()).toEqual([CREATED, CONFLICT])
      const kept = (await owner.financeTransaction.findUniqueOrThrow({ where: { id: target.id } }))
        .documentMediaId
      expect([first, second]).toContain(kept)
    })

    it('answers a void and an attach at once with a typed answer, never a 500', async () => {
      const target = await registered(ctx.adminA, ctx.storeA, expense())
      const mediaId = await receipt(target.id)
      const [voided, attached] = await Promise.all([
        api(app, ctx.adminA, ctx.storeA)
          .post(ApiRoutes.finance.transactions.void(target.id))
          .send({ reason: 'Gone' }),
        attach(bookkeeper, ctx.storeA, target.id, mediaId)
      ])
      expect(voided.status).toBe(CREATED)
      expect([CREATED, CONFLICT]).toContain(attached.status)
    })
  })

  describe('the signed links of the receipt', () => {
    async function withReceipt(status: string): Promise<string> {
      const target = await registered(ctx.adminA, ctx.storeA, expense())
      const mediaId = await receipt(target.id)
      expect((await attach(bookkeeper, ctx.storeA, target.id, mediaId)).status).toBe(CREATED)
      // The scan verdict of a file that was clean when it was attached can only be the one it had; the rows are moved by the owner to
      // read what the route says for each state
      await owner.media.update({ where: { id: mediaId }, data: { status } })
      return target.id
    }
    const urls = (actor: Actor, store: { id: string }, transactionId: string) =>
      api(app, actor, store).get(ApiRoutes.finance.transactions.document(transactionId))

    it('is given to who reads the journal, for a file the scan found clean', async () => {
      const id = await withReceipt('clean')
      const response = await urls(journalReader, ctx.storeA, id)
      expect(response.status).toBe(OK)
      expect((response.body as { url: string }).url).toEqual(expect.any(String))
    })

    it('is given through another store of the organization: the books are the organization`s', async () => {
      const id = await withReceipt('clean')
      const media = app.get(MediaService, { strict: false })
      const read = jest.spyOn(media, 'urlsFor')
      try {
        const response = await urls(ctx.adminA2, ctx.storeA2, id)
        expect(response.status).toBe(OK)
        expect((response.body as { url: string }).url).toEqual(expect.any(String))
        // Positive control of the spies of the refusals below: the file is signed in ITS store, not the one of the header
        expect(read).toHaveBeenCalledWith(ctx.storeA.id, expect.any(String), expect.anything())
      } finally {
        read.mockRestore()
      }
    })

    it('is not given for a file that is pending the scan, or one that was found infected', async () => {
      for (const status of ['pending', 'infected', 'unscannable']) {
        const id = await withReceipt(status)
        const response = await urls(journalReader, ctx.storeA, id)
        expect(response.status).toBeGreaterThanOrEqual(BAD_REQUEST)
        // A typed refusal of the pipeline, never an error of the server
        expect(response.status).toBeLessThan(500)
      }
    })

    it('is 404 for a transaction with no receipt, and for a transaction of another organization', async () => {
      expect((await urls(journalReader, ctx.storeA, expenseA.id)).status).toBe(NOT_FOUND)
      const id = await withReceipt('clean')
      expect((await urls(ctx.adminB, ctx.storeB, id)).status).toBe(NOT_FOUND)
    })

    it('is refused to who does not read the journal, before anything is read or signed', async () => {
      const id = await withReceipt('clean')
      const storage = app.get(StorageService, { strict: false })
      const media = app.get(MediaService, { strict: false })
      const signed = jest.spyOn(storage, 'downloadUrl')
      const read = jest.spyOn(media, 'urlsFor')
      try {
        const response = await urls(ctx.viewerA, ctx.storeA, id)
        expect(response.status).toBe(FORBIDDEN)
        expect(signed).not.toHaveBeenCalled()
        expect(read).not.toHaveBeenCalled()
      } finally {
        signed.mockRestore()
        read.mockRestore()
      }
    })

    it('answers the same 404 for no transaction, another organization, no receipt, and signs nothing', async () => {
      const id = await withReceipt('clean')
      const storage = app.get(StorageService, { strict: false })
      const signed = jest.spyOn(storage, 'downloadUrl')
      try {
        const answers = await Promise.all([
          urls(journalReader, ctx.storeA, randomUUID()),
          urls(ctx.adminB, ctx.storeB, id),
          urls(journalReader, ctx.storeA, expenseA.id)
        ])
        for (const answer of answers) expect(answer.status).toBe(NOT_FOUND)
        const shapes = answers.map(answer => {
          const { code, message } = (answer.body as { error: { code: string; message: string } })
            .error
          return { code, message }
        })
        expect(shapes[1]).toEqual(shapes[0])
        expect(shapes[2]).toEqual(shapes[0])
        expect(signed).not.toHaveBeenCalled()
      } finally {
        signed.mockRestore()
      }
    })
  })

  // The net under the service: whoever writes the table, the receipt is one made for this transaction, in this organization, once
  describe('the database, whoever writes', () => {
    const setReceipt = (id: string, mediaId: string) =>
      owner.financeTransaction.update({ where: { id }, data: { documentMediaId: mediaId } })

    it('takes the receipt once, and a second write moves nothing', async () => {
      const target = await registered(ctx.adminA, ctx.storeA, expense())
      const first = await receipt(target.id)
      await expect(setReceipt(target.id, first)).resolves.toBeDefined()
      await expect(setReceipt(target.id, await receipt(target.id))).rejects.toThrow(
        /FINANCE_TRANSACTION_IMMUTABLE/
      )
      await expect(
        owner.financeTransaction.update({
          where: { id: target.id },
          data: { documentMediaId: null }
        })
      ).rejects.toThrow(/FINANCE_TRANSACTION_IMMUTABLE/)
    })

    it('refuses a file made for another transaction', async () => {
      const target = await registered(ctx.adminA, ctx.storeA, expense())
      const other = await registered(ctx.adminA, ctx.storeA, expense())
      await expect(setReceipt(target.id, await receipt(other.id))).rejects.toThrow(
        /FINANCE_TRANSACTION_DOCUMENT/
      )
    })

    it('refuses a file of a store of another organization, even when it names this transaction', async () => {
      const target = await registered(ctx.adminA, ctx.storeA, expense())
      const foreign = await receipt(target.id, { storeId: ctx.storeB.id })
      await expect(setReceipt(target.id, foreign)).rejects.toThrow(/FINANCE_TRANSACTION_DOCUMENT/)
    })

    it('refuses a file with no transaction, and a transaction on a file that is not a receipt', async () => {
      const target = await registered(ctx.adminA, ctx.storeA, expense())
      const loose = randomUUID()
      await owner.media.create({
        data: {
          id: loose,
          storeId: ctx.storeA.id,
          purpose: 'finance_document',
          key: `${prefix}/finance-document/${loose}`,
          filename: 'receipt.png',
          contentType: 'image/png',
          fileSize: 1,
          status: 'clean'
        }
      })
      await expect(setReceipt(target.id, loose)).rejects.toThrow(/FINANCE_TRANSACTION_DOCUMENT/)
      await expect(receipt(target.id, { purpose: 'message' })).rejects.toThrow(
        /chk_media_finance_parent|check constraint/i
      )
    })

    it('does not move the receipt and anything else together, nor the pointer that voids', async () => {
      const target = await registered(ctx.adminA, ctx.storeA, expense())
      const file = await receipt(target.id)
      await expect(
        owner.financeTransaction.update({
          where: { id: target.id },
          data: { documentMediaId: file, memo: 'changed' }
        })
      ).rejects.toThrow(/FINANCE_TRANSACTION_IMMUTABLE/)
      await expect(
        owner.financeTransaction.update({
          where: { id: target.id },
          data: { documentMediaId: file, amountCents: 1 }
        })
      ).rejects.toThrow(/FINANCE_TRANSACTION_IMMUTABLE/)
      await expect(
        owner.financeTransaction.update({
          where: { id: target.id },
          data: { documentMediaId: file, voidedByEntryId: target.id }
        })
      ).rejects.toThrow(/FINANCE_TRANSACTION_/)
    })

    it('takes no receipt for a voided transaction', async () => {
      const target = await registered(ctx.adminA, ctx.storeA, expense())
      await api(app, ctx.adminA, ctx.storeA)
        .post(ApiRoutes.finance.transactions.void(target.id))
        .send({ reason: 'Gone' })
      await expect(setReceipt(target.id, await receipt(target.id))).rejects.toThrow(
        /FINANCE_TRANSACTION_DOCUMENT/
      )
    })

    it('takes only a file the scan found clean', async () => {
      const target = await registered(ctx.adminA, ctx.storeA, expense())
      await expect(
        setReceipt(target.id, await receipt(target.id, { status: 'pending' }))
      ).rejects.toThrow(/FINANCE_TRANSACTION_DOCUMENT/)
    })

    it('keeps the purpose, the parent and the store of a file that is a receipt', async () => {
      const target = await registered(ctx.adminA, ctx.storeA, expense())
      const file = await receipt(target.id)
      await setReceipt(target.id, file)
      await expect(
        owner.media.update({ where: { id: file }, data: { financeTransactionId: null } })
      ).rejects.toThrow(/FINANCE_TRANSACTION_DOCUMENT/)
      await expect(
        owner.media.update({ where: { id: file }, data: { purpose: 'message' } })
      ).rejects.toThrow(/FINANCE_TRANSACTION_DOCUMENT|chk_media_finance_parent/)
      await expect(
        owner.media.update({ where: { id: file }, data: { storeId: ctx.storeB.id } })
      ).rejects.toThrow(/FINANCE_TRANSACTION_DOCUMENT/)
      // What is not part of that is still the pipeline's to move
      await expect(
        owner.media.update({ where: { id: file }, data: { filename: 'renamed.png' } })
      ).resolves.toBeDefined()
    })

    it('keeps the file of a receipt: it is not deleted while its transaction points at it', async () => {
      const target = await registered(ctx.adminA, ctx.storeA, expense())
      const file = await receipt(target.id)
      await setReceipt(target.id, file)
      await expect(owner.media.delete({ where: { id: file } })).rejects.toThrow()
    })
  })
})
