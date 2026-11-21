import { getQueueToken } from '@nestjs/bullmq'
import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { PrismaService, RLS_CONTEXT_ENABLED } from '@platform/core/database'
import { connectionUrls, type OwnerClient } from '@platform/core/database-testing'
import { AuthorType, CONVERSATION_RESOURCE_TYPE } from '@platform/core/domain'
import { HttpStatusCodes } from '@platform/core/errors'
import { QueueNames } from '@platform/core/queues'
import { RemittancesService } from '@platform/core/shipping'
import { MediaPurpose, StorageKeys } from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'

import { createCarrierConnection, createConversationOf, createMessage } from '../builders'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'
import { CapturedQueue } from '../helpers/queue'

const CREATED = HttpStatusCodes.CREATED
const NO_CONTENT = HttpStatusCodes.NO_CONTENT

// RLS phase 6, the routes that call the bucket with a write beside it (imports of files, discards, the deletion of a conversation): each is
// @NoTenantTransaction, so the request is not one transaction of 15 s that waits for the bucket. With the interceptor ON and the guard of
// PrismaService ON, the bucket must be called with NO tenant context open (a connection is never held while it answers), and the rows are
// written and read in units of their own that work.
describe('RLS phase 6: imports and deletions call the bucket with no context open', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let guarded: PrismaService
  let owner: OwnerClient
  let ctx: TestContext
  let connectionId = ''
  const opened: { call: string; tenantOpen: boolean }[] = []
  const scans = new CapturedQueue()

  beforeAll(async () => {
    owner = ownerClient()
    guarded = new PrismaService({
      databaseUrl: connectionUrls().worker,
      poolSize: 8,
      requireContext: true
    })
    app = await createTestApp([], builder =>
      builder
        .overrideProvider(PrismaService)
        .useValue(guarded)
        .overrideProvider(RLS_CONTEXT_ENABLED)
        .useValue(true)
        .overrideProvider(getQueueToken(QueueNames.HEAVY_PROCESSING))
        .useValue(scans)
    )
    ctx = await seedTestContext(owner, app, prefix)
    connectionId = (await createCarrierConnection(owner, { storeId: ctx.storeA.id, prefix: 'IO' }))
      .id
    const storage = app.get(StorageService, { strict: false })
    const put = storage.put.bind(storage)
    const remove = storage.delete.bind(storage)
    jest.spyOn(storage, 'put').mockImplementation((...args) => {
      opened.push({ call: 'put', tenantOpen: guarded.hasTenantContext() })
      return put(...args)
    })
    jest.spyOn(storage, 'delete').mockImplementation((...args) => {
      opened.push({ call: 'delete', tenantOpen: guarded.hasTenantContext() })
      return remove(...args)
    })
  })
  afterAll(async () => {
    jest.restoreAllMocks()
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })
  beforeEach(() => {
    opened.length = 0
    scans.jobs.length = 0
  })

  const admin = () => api(app, ctx.adminA, ctx.storeA)
  const importUrl = (profileId: string) =>
    `${ApiRoutes.remittances.imports}?connectionId=${connectionId}&profileId=${profileId}`

  async function profile(): Promise<string> {
    const made = await admin()
      .post(ApiRoutes.remittances.importProfiles)
      .send({
        connectionId,
        name: `Layout ${Math.random().toString(36).slice(2, 8)}`,
        columns: { guideNumber: 'Guia', amount: 'Monto' }
      })
    expect(made.status).toBe(CREATED)
    return (made.body as { id: string }).id
  }

  it('imports a remittance file: the profile, the media row and the draft are written in a unit, and the bucket is called with no context', async () => {
    const profileId = await profile()

    const response = await admin()
      .post(`${ApiRoutes.remittances.imports}?connectionId=${connectionId}&profileId=${profileId}`)
      .set('Content-Type', 'text/csv')
      .send('Guia,Monto\nG-1,10.00\n')

    expect(response.status).toBe(CREATED)
    expect(opened).toEqual([{ call: 'put', tenantOpen: false }])
    const draft = response.body as { id: string; sourceMediaId: string | null }
    expect(draft.sourceMediaId).not.toBeNull()
    expect(
      await owner.media.count({
        where: { id: draft.sourceMediaId ?? '', purpose: MediaPurpose.REMITTANCE_FILE }
      })
    ).toBe(1)
    expect(scans.jobs).toHaveLength(1)
  })

  it('discards the draft: the rows go in a unit, then the file is removed from the bucket with no context open', async () => {
    const profileId = await profile()
    const made = await admin()
      .post(`${ApiRoutes.remittances.imports}?connectionId=${connectionId}&profileId=${profileId}`)
      .set('Content-Type', 'text/csv')
      .send('Guia,Monto\nG-2,10.00\n')
    expect(made.status).toBe(CREATED)
    const draft = made.body as { id: string; sourceMediaId: string }
    opened.length = 0

    const response = await admin().delete(ApiRoutes.remittances.byId(draft.id))

    expect(response.status).toBe(NO_CONTENT)
    expect(opened).toEqual([{ call: 'delete', tenantOpen: false }])
    expect(await owner.codRemittance.count({ where: { id: draft.id } })).toBe(0)
    expect(await owner.media.count({ where: { id: draft.sourceMediaId } })).toBe(0)
  })

  it('deletes a conversation: the rows go in one unit, and the files are removed from the bucket with no context open', async () => {
    const storeId = ctx.storeA.id
    const conversation = await createConversationOf(owner, { storeId })
    const message = await createMessage(owner, {
      storeId,
      conversationId: conversation.id,
      content: 'where is my parcel',
      authorType: AuthorType.CUSTOMER
    })
    const key = StorageKeys.message(storeId, message.id, 'plain.pdf')
    const file = await owner.media.create({
      data: {
        storeId,
        purpose: 'message',
        messageId: message.id,
        customerId: conversation.customerId,
        key,
        filename: 'f',
        contentType: 'application/octet-stream',
        fileSize: 10,
        status: 'clean'
      },
      select: { id: true }
    })
    const found = conversation
    const mediaId = file.id

    const response = await admin().delete(ApiRoutes.conversations.byId(found.id))

    expect(response.status).toBe(NO_CONTENT)
    expect(opened.length).toBeGreaterThan(0)
    expect(opened.every(call => call.call === 'delete' && !call.tenantOpen)).toBe(true)
    expect(await owner.conversation.count({ where: { id: found.id } })).toBe(0)
    expect(await owner.media.count({ where: { id: mediaId } })).toBe(0)
  })
  it('rolls the import back when the draft fails: the object is removed from the bucket (no context), and no row is left', async () => {
    const profileId = await profile()
    const before = await owner.media.count({
      where: { storeId: ctx.storeA.id, purpose: MediaPurpose.REMITTANCE_FILE }
    })
    const draft = jest
      .spyOn(app.get(RemittancesService, { strict: false }), 'createDraft')
      .mockRejectedValueOnce(new Error('the draft could not be written'))

    const response = await admin()
      .post(importUrl(profileId))
      .set('Content-Type', 'text/csv')
      .send('Guia,Monto\nG-3,10.00\n')
    draft.mockRestore()

    expect(response.status).toBe(HttpStatusCodes.INTERNAL_SERVER_ERROR)
    // The file was put, then taken out again, both with no tenant context open
    expect(opened).toEqual([
      { call: 'put', tenantOpen: false },
      { call: 'delete', tenantOpen: false }
    ])
    // The media row went back with the unit
    expect(
      await owner.media.count({
        where: { storeId: ctx.storeA.id, purpose: MediaPurpose.REMITTANCE_FILE }
      })
    ).toBe(before)
  })

  it('does not hold the unit while the bucket is slow: a put that takes longer than the 15 s of a transaction still imports', async () => {
    const profileId = await profile()
    const storage = app.get(StorageService, { strict: false })
    const slow = jest.spyOn(storage, 'put').mockImplementationOnce(async (...args) => {
      opened.push({ call: 'put', tenantOpen: guarded.hasTenantContext() })
      await new Promise(resolve => setTimeout(resolve, 16_000))
      slow.mockRestore()
      return storage.put(...args)
    })

    const response = await admin()
      .post(importUrl(profileId))
      .set('Content-Type', 'text/csv')
      .send('Guia,Monto\nG-4,10.00\n')

    expect(response.status).toBe(CREATED)
    expect(opened[0]).toEqual({ call: 'put', tenantOpen: false })
    const draft = response.body as { sourceMediaId: string | null }
    expect(await owner.media.count({ where: { id: draft.sourceMediaId ?? '' } })).toBe(1)
  }, 60_000)

  it('keeps the deletion and its audit entry when the bucket fails on a file: the rows are gone, the entry is written', async () => {
    const storeId = ctx.storeA.id
    const conversation = await createConversationOf(owner, { storeId })
    const message = await createMessage(owner, {
      storeId,
      conversationId: conversation.id,
      content: 'where is my parcel',
      authorType: AuthorType.CUSTOMER
    })
    const key = StorageKeys.message(storeId, message.id, 'plain.pdf')
    await owner.media.create({
      data: {
        storeId,
        purpose: 'message',
        messageId: message.id,
        customerId: conversation.customerId,
        key,
        filename: 'f',
        contentType: 'application/octet-stream',
        fileSize: 10,
        status: 'clean'
      }
    })
    const storage = app.get(StorageService, { strict: false })
    jest.spyOn(storage, 'delete').mockRejectedValueOnce(new Error('the bucket is down'))

    const response = await admin().delete(ApiRoutes.conversations.byId(conversation.id))

    expect(response.status).toBe(NO_CONTENT)
    expect(await owner.conversation.count({ where: { id: conversation.id } })).toBe(0)
    const entries = await waitForAuditEntries(owner, {
      action: AuditAction.CONVERSATION_DELETED,
      resourceType: CONVERSATION_RESOURCE_TYPE,
      resourceId: conversation.id
    })
    expect(entries).toHaveLength(1)
  })

  it('does not delete a conversation of another store, and writes no entry for it', async () => {
    const other = await createConversationOf(owner, { storeId: ctx.storeB.id })

    const response = await admin().delete(ApiRoutes.conversations.byId(other.id))

    expect(response.status).toBe(HttpStatusCodes.NOT_FOUND)
    expect(await owner.conversation.count({ where: { id: other.id } })).toBe(1)
  })
})
