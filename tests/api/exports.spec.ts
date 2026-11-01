import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import type { PinoLogger } from 'nestjs-pino'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { Permissions, RoleNames } from '@platform/core/auth'
import { DataRetentionPolicies } from '@platform/core/compliance'
import { PrismaService } from '@platform/core/database'
import type { OwnerClient } from '@platform/core/database-testing'
import { AuthorType, MessageType } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { ExportLimits } from '@platform/core/exports'
import {
  ExportFormats,
  ExportStatus,
  ExportTypes,
  JobNames,
  QueueNames
} from '@platform/core/queues'
import { StorageKeys } from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'

import { CsvExportWriter } from '../../apps/worker/src/exports/csv-export-writer'
import { ExpiredExportsCleaner } from '../../apps/worker/src/exports/expired-exports-cleaner.service'
import { ExportGenerator } from '../../apps/worker/src/exports/export-generator.service'
import { ZipExportWriter } from '../../apps/worker/src/exports/zip-export-writer'
import {
  createConversationOf,
  createCustomer,
  createMessage,
  createRole,
  createTag
} from '../builders'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { createActor, seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'
import { queueOf } from '../helpers/queue'

interface ErrorBody {
  error: { code: string }
}
interface ExportBody {
  id: string
  type: string
  status: string
  filename: string | null
  rowCount: number | null
}
interface PageBody {
  data: ExportBody[]
  hasMore: boolean
}
interface DownloadBody {
  url: string
  filename: string
}

const ACCEPTED = 202
const OK = 200
const FORBIDDEN = 403
const NOT_FOUND = 404
const CONFLICT = 409
const GONE = 410
const TOO_MANY = 429
const BOM = '﻿'
const MAX_FILE = 5_000_000

// The exports center and the two CSV exports, from the request to the signed download: the api makes
// the row, the generator of the worker (run here by hand, as the worker would) makes the file.
describe('Exports', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let storage: StorageService
  let generator: ExportGenerator
  let cleaner: ExpiredExportsCleaner
  const keys: string[] = []

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    const prisma = app.get(PrismaService, { strict: false })
    storage = app.get(StorageService, { strict: false })
    const logger = {
      setContext: jest.fn(),
      error: jest.fn(),
      warn: jest.fn()
    } as unknown as PinoLogger
    generator = new ExportGenerator(
      prisma,
      new CsvExportWriter(storage),
      new ZipExportWriter(storage, logger),
      storage,
      app.get(AuditService, { strict: false }),
      logger
    )
    cleaner = new ExpiredExportsCleaner(prisma, storage, logger)
  })
  afterAll(async () => {
    for (const key of keys) await storage.delete(key)
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })
  // Each case counts the exports it makes: the limit of active ones is per store
  afterEach(async () => {
    await owner.export.updateMany({
      where: { storeId: { in: [ctx.storeA.id, ctx.storeB.id] }, status: ExportStatus.PENDING },
      data: { status: ExportStatus.FAILED }
    })
  })

  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)

  async function request(path: string): Promise<ExportBody> {
    const response = await asAdmin().get(path)
    expect(response.status).toBe(ACCEPTED)
    return response.body as ExportBody
  }

  async function made(exportId: string): Promise<string> {
    await generator.generate(exportId, false)
    const row = await owner.export.findUniqueOrThrow({ where: { id: exportId } })
    expect(row.status).toBe(ExportStatus.READY)
    const key = row.key ?? ''
    keys.push(key)
    const body = await storage.read(key, MAX_FILE)
    return body?.toString('utf8') ?? ''
  }

  describe('the customers file', () => {
    it('asks for the permission, queues the job and answers with the export', async () => {
      const denied = await api(app, ctx.agentA, ctx.storeA).get(ApiRoutes.customers.export)
      expect(denied.status).toBe(FORBIDDEN)

      const view = await request(ApiRoutes.customers.export)

      expect(view).toMatchObject({ type: ExportTypes.CUSTOMERS, status: ExportStatus.PENDING })
      const row = await owner.export.findUniqueOrThrow({ where: { id: view.id } })
      expect(row.storeId).toBe(ctx.storeA.id)
      expect(row.requestedBy).toBe(ctx.adminA.id)
      expect(row.expiresAt.getTime()).toBeGreaterThan(
        Date.now() + (DataRetentionPolicies.EXPORTS.defaultDays - 1) * 86_400_000
      )
      expect(queueOf(app, QueueNames.EXPORTS).jobs).toContainEqual({
        name: JobNames.GENERATE_EXPORT,
        data: { exportId: view.id },
        opts: { jobId: `${JobNames.GENERATE_EXPORT}-${view.id}` }
      })
    })

    it('writes the columns, defuses a formula in a name, and leaves out other stores and absorbed customers', async () => {
      const mine = await createCustomer(owner, { storeId: ctx.storeA.id, name: '=HYPERLINK("x")' })
      const plain = await createCustomer(owner, { storeId: ctx.storeA.id, name: 'Ana, "la" Gómez' })
      const foreign = await createCustomer(owner, { storeId: ctx.storeB.id, name: 'Foreign' })
      const absorbed = await createCustomer(owner, { storeId: ctx.storeA.id, name: 'Absorbed' })
      await owner.customer.update({ where: { id: absorbed.id }, data: { mergedIntoId: plain.id } })
      const tag = await createTag(owner, { storeId: ctx.storeA.id, name: `${prefix}-vip` })
      await owner.customer.update({
        where: { id: plain.id },
        data: { tags: { connect: { id: tag.id } }, isCaution: true, cautionReason: 'chargeback' }
      })
      await owner.address.create({
        data: { customerId: plain.id, line1: 'Calle 1', city: 'San Salvador', isDefault: true }
      })
      await owner.customerNote.create({
        data: { customerId: plain.id, authorId: ctx.adminA.id, content: 'private note text' }
      })

      const view = await request(ApiRoutes.customers.export)
      const file = await made(view.id)

      expect(file.startsWith(BOM + 'id,name,email,phone')).toBe(true)
      expect(file).toContain(`'=HYPERLINK(""x"")`)
      expect(file).toContain('"Ana, ""la"" Gómez"')
      expect(file).toContain(`${prefix}-vip`)
      expect(file).toContain('San Salvador')
      expect(file).toContain('chargeback')
      expect(file).toContain(mine.id)
      expect(file).not.toContain(foreign.id)
      expect(file).not.toContain(absorbed.id)
      // The text of a note is internal: only how many there are leaves
      expect(file).not.toContain('private note text')
      expect(file.endsWith('\r\n')).toBe(true)
    })

    it('keeps the search text of the list, and audits the file with its row count', async () => {
      const wanted = await createCustomer(owner, {
        storeId: ctx.storeA.id,
        name: `${prefix}-needle`
      })
      await createCustomer(owner, { storeId: ctx.storeA.id, name: `${prefix}-other` })

      const view = await request(`${ApiRoutes.customers.export}?q=needle`)
      const file = await made(view.id)

      expect(file).toContain(wanted.id)
      expect(file).not.toContain(`${prefix}-other`)
      const row = await owner.export.findUniqueOrThrow({ where: { id: view.id } })
      expect(row.rowCount).toBe(file.split('\r\n').filter(Boolean).length - 1)
      const [entry] = await waitForAuditEntries(owner, {
        action: AuditAction.CUSTOMER_EXPORTED,
        resourceId: view.id
      })
      expect(entry?.userId).toBe(ctx.adminA.id)
      expect(entry?.storeId).toBe(ctx.storeA.id)
      expect(entry?.metadata).toMatchObject({ rowCount: row.rowCount, filters: { q: 'needle' } })
    })

    it('refuses a filter it does not know', async () => {
      const response = await asAdmin().get(`${ApiRoutes.customers.export}?role=admin`)
      expect(response.status).toBe(400)
    })

    it('makes the file once when the job arrives twice', async () => {
      const view = await request(ApiRoutes.customers.export)
      await made(view.id)
      const before = await owner.export.findUniqueOrThrow({ where: { id: view.id } })

      await generator.generate(view.id, false)

      const after = await owner.export.findUniqueOrThrow({ where: { id: view.id } })
      expect(after.completedAt).toEqual(before.completedAt)
    })

    it('fails for good a row whose filters do not fit, and says which code', async () => {
      const row = await owner.export.create({
        data: {
          storeId: ctx.storeA.id,
          requestedBy: ctx.adminA.id,
          type: ExportTypes.CUSTOMERS,
          format: ExportFormats.CSV,
          filters: { q: 5 },
          expiresAt: new Date(Date.now() + 86_400_000)
        }
      })

      await expect(generator.generate(row.id, false)).rejects.toThrow('does not fit')

      const after = await owner.export.findUniqueOrThrow({ where: { id: row.id } })
      expect(after).toMatchObject({ status: ExportStatus.FAILED, error: ErrorCodes.EXPORT_FAILED })
    })
  })

  describe('the conversations file', () => {
    it('needs both permissions and holds a row per message, without the lines of the platform, the notes of the team or the text of a deleted message', async () => {
      const supervisor = await createActor(owner, app, {
        prefix,
        name: 'supervisor',
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        roleId: ctx.roleIds[RoleNames.SUPERVISOR]
      })
      const denied = await api(app, ctx.agentA, ctx.storeA).get(ApiRoutes.conversations.export)
      expect(denied.status).toBe(FORBIDDEN)

      const conversation = await createConversationOf(owner, { storeId: ctx.storeA.id })
      const at = (minutes: number) => new Date(Date.UTC(2026, 10, 1, 10, minutes))
      await createMessage(owner, {
        storeId: ctx.storeA.id,
        conversationId: conversation.id,
        content: 'first line',
        createdAt: at(1)
      })
      await createMessage(owner, {
        storeId: ctx.storeA.id,
        conversationId: conversation.id,
        content: 'a system line',
        type: MessageType.SYSTEM,
        authorType: AuthorType.SYSTEM,
        createdAt: at(2)
      })
      await createMessage(owner, {
        storeId: ctx.storeA.id,
        conversationId: conversation.id,
        content: 'a private note',
        type: MessageType.INTERNAL_NOTE,
        createdAt: at(3)
      })
      const removed = await createMessage(owner, {
        storeId: ctx.storeA.id,
        conversationId: conversation.id,
        content: 'the customer regrets this',
        createdAt: at(4)
      })
      await owner.message.update({
        where: { id: removed.id },
        data: { deletedAt: new Date(), deletedByType: AuthorType.CUSTOMER }
      })
      const other = await createConversationOf(owner, { storeId: ctx.storeB.id })
      await createMessage(owner, {
        storeId: ctx.storeB.id,
        conversationId: other.id,
        content: 'secret of store B'
      })

      const response = await api(app, supervisor, ctx.storeA).get(ApiRoutes.conversations.export)
      expect(response.status).toBe(ACCEPTED)
      const file = await made((response.body as ExportBody).id)

      expect(file.startsWith(BOM + 'conversation_id,message_id,sent_at')).toBe(true)
      expect(file).toContain('first line')
      expect(file).not.toContain('a system line')
      expect(file).not.toContain('a private note')
      expect(file).not.toContain('the customer regrets this')
      expect(file).not.toContain('secret of store B')
      // The deleted message is still a row, without its text, and says so
      expect(file).toContain(removed.id)
      expect(file).toContain(',true\r\n')
    })

    it('holds only what the member could see when they asked', async () => {
      const mine = await createConversationOf(owner, {
        storeId: ctx.storeA.id,
        assignedTo: ctx.agentA.id
      })
      const nobodys = await createConversationOf(owner, { storeId: ctx.storeA.id })
      const theirs = await createConversationOf(owner, {
        storeId: ctx.storeA.id,
        assignedTo: ctx.adminA.id
      })
      for (const [conversation, text] of [
        [mine, 'for-agent'],
        [nobodys, 'for-nobody'],
        [theirs, 'for-admin']
      ] as const) {
        await createMessage(owner, {
          storeId: ctx.storeA.id,
          conversationId: conversation.id,
          content: text
        })
      }
      // An agent without VIEW_ALL: what the row freezes is the permissions held at the request
      const row = await owner.export.create({
        data: {
          storeId: ctx.storeA.id,
          requestedBy: ctx.agentA.id,
          type: ExportTypes.CONVERSATIONS,
          format: ExportFormats.CSV,
          filters: {
            filter: {},
            viewer: { userId: ctx.agentA.id, held: [Permissions.CONVERSATIONS_VIEW] }
          },
          expiresAt: new Date(Date.now() + 86_400_000)
        }
      })

      const file = await made(row.id)

      expect(file).toContain('for-agent')
      expect(file).toContain('for-nobody')
      expect(file).not.toContain('for-admin')
    })

    it('refuses the history of what was archived to who may not archive', async () => {
      const supervisorOnly = await createRole(owner, {
        storeId: ctx.storeA.id,
        permissions: [Permissions.CONVERSATIONS_VIEW, Permissions.CONVERSATIONS_EXPORT]
      })
      const member = await createActor(owner, app, {
        prefix,
        name: 'exporter',
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        roleId: supervisorOnly.id
      })

      const response = await api(app, member, ctx.storeA).get(
        `${ApiRoutes.conversations.export}?status=ARCHIVED`
      )

      expect(response.status).toBe(FORBIDDEN)
    })
  })

  describe('the exports center', () => {
    it('lists only the exports of the member, newest first, and reads one by id', async () => {
      const first = await request(ApiRoutes.customers.export)
      await made(first.id)
      const second = await request(ApiRoutes.customers.export)

      const list = await asAdmin().get(ApiRoutes.exports.list)
      expect(list.status).toBe(OK)
      const ids = (list.body as PageBody).data.map(item => item.id)
      expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id))

      const one = await asAdmin().get(ApiRoutes.exports.byId(second.id))
      expect(one.status).toBe(OK)
      expect((one.body as ExportBody).id).toBe(second.id)
    })

    it('shows an export to who asked for it and to nobody else: another member, another store, an agent', async () => {
      const view = await request(ApiRoutes.customers.export)
      const colleague = await createActor(owner, app, {
        prefix,
        name: 'colleague',
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        roleId: ctx.roleIds[RoleNames.ADMIN]
      })

      const colleagueSees = await api(app, colleague, ctx.storeA).get(
        ApiRoutes.exports.byId(view.id)
      )
      const otherStore = await api(app, ctx.adminA2, ctx.storeA2).get(
        ApiRoutes.exports.byId(view.id)
      )
      const claimingOwnStore = await api(app, ctx.adminB, ctx.storeB).get(
        ApiRoutes.exports.byId(view.id)
      )
      const agent = await api(app, ctx.agentA, ctx.storeA).get(ApiRoutes.exports.list)
      const colleagueList = await api(app, colleague, ctx.storeA).get(ApiRoutes.exports.list)

      expect(colleagueSees.status).toBe(NOT_FOUND)
      expect(otherStore.status).toBe(NOT_FOUND)
      expect(claimingOwnStore.status).toBe(NOT_FOUND)
      expect(agent.status).toBe(FORBIDDEN)
      expect((colleagueList.body as PageBody).data.map(item => item.id)).not.toContain(view.id)
    })

    it('does not show a kind the role may no longer make', async () => {
      const view = await request(ApiRoutes.customers.export)
      // The same member, with a role that has lost CUSTOMERS_EXPORT but still exports media
      const role = await createRole(owner, {
        storeId: ctx.storeA.id,
        permissions: [Permissions.MEDIA_DOWNLOAD_ALL]
      })
      const member = await createActor(owner, app, {
        prefix,
        name: 'media-only',
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        roleId: role.id
      })
      await owner.export.update({ where: { id: view.id }, data: { requestedBy: member.id } })

      const response = await api(app, member, ctx.storeA).get(ApiRoutes.exports.byId(view.id))

      expect(response.status).toBe(NOT_FOUND)
    })

    it('does not give a link while the file is being made, and gives one when it is ready', async () => {
      const view = await request(ApiRoutes.customers.export)

      const early = await asAdmin().get(ApiRoutes.exports.download(view.id))
      expect(early.status).toBe(CONFLICT)
      expect((early.body as ErrorBody).error.code).toBe(ErrorCodes.EXPORT_NOT_READY)

      await made(view.id)
      const ready = await asAdmin().get(ApiRoutes.exports.download(view.id))
      expect(ready.status).toBe(OK)
      const { url, filename } = ready.body as DownloadBody
      expect(filename).toMatch(/^customers-\d{4}-\d{2}-\d{2}\.csv$/)

      const file = await fetch(url)
      expect(file.status).toBe(OK)
      expect(file.headers.get('content-type')).toContain('text/csv')
      expect(file.headers.get('content-disposition')).toContain('attachment')
    })

    it('refuses the download of a failed export and of an expired one', async () => {
      const failed = await request(ApiRoutes.customers.export)
      await owner.export.update({
        where: { id: failed.id },
        data: { status: ExportStatus.FAILED, error: ErrorCodes.EXPORT_FAILED }
      })
      const expired = await request(ApiRoutes.customers.export)
      const file = await made(expired.id)
      expect(file).toContain('id,name')
      await owner.export.update({
        where: { id: expired.id },
        data: { expiresAt: new Date(Date.now() - 1000) }
      })

      const failedResponse = await asAdmin().get(ApiRoutes.exports.download(failed.id))
      const expiredResponse = await asAdmin().get(ApiRoutes.exports.download(expired.id))

      expect((failedResponse.body as ErrorBody).error.code).toBe(ErrorCodes.EXPORT_FAILED)
      expect(expiredResponse.status).toBe(GONE)
      expect((expiredResponse.body as ErrorBody).error.code).toBe(ErrorCodes.EXPORT_EXPIRED)
      const view = await asAdmin().get(ApiRoutes.exports.byId(expired.id))
      expect((view.body as ExportBody).status).toBe(ExportStatus.EXPIRED)
    })

    it('stops a store from piling up exports of personal data', async () => {
      await owner.export.updateMany({
        where: { storeId: ctx.storeA.id, status: ExportStatus.PENDING },
        data: { status: ExportStatus.FAILED }
      })
      for (let count = 0; count < ExportLimits.MAX_ACTIVE_PER_STORE; count += 1) {
        await request(ApiRoutes.customers.export)
      }

      const response = await asAdmin().get(ApiRoutes.customers.export)

      expect(response.status).toBe(TOO_MANY)
      expect((response.body as ErrorBody).error.code).toBe(ErrorCodes.RATE_LIMIT_EXCEEDED)
    })
  })

  describe('the cleanup', () => {
    it('deletes the file past its date and gives up on an export whose job is gone', async () => {
      const view = await request(ApiRoutes.customers.export)
      await made(view.id)
      const row = await owner.export.findUniqueOrThrow({ where: { id: view.id } })
      await owner.export.update({
        where: { id: view.id },
        data: { expiresAt: new Date(Date.now() - 1000) }
      })
      const lost = await owner.export.create({
        data: {
          storeId: ctx.storeA.id,
          requestedBy: ctx.adminA.id,
          type: ExportTypes.CUSTOMERS,
          format: ExportFormats.CSV,
          createdAt: new Date(Date.now() - (ExportLimits.PENDING_GIVE_UP_HOURS + 1) * 3_600_000),
          expiresAt: new Date(Date.now() + 86_400_000)
        }
      })

      // The upload of a worker that died before the row turned ready
      const orphan = StorageKeys.export(ctx.storeA.id, lost.id, 'customers-2026-11-01.csv')
      await storage.put(orphan, Buffer.from('x'), 'text/csv')
      keys.push(orphan)

      const report = await cleaner.run()

      expect(await storage.head(orphan)).toBeNull()
      expect(report.filesDeleted).toBeGreaterThanOrEqual(1)
      expect(await storage.head(row.key ?? '')).toBeNull()
      const after = await owner.export.findUniqueOrThrow({ where: { id: view.id } })
      expect(after).toMatchObject({ status: ExportStatus.EXPIRED, key: null })
      const gaveUp = await owner.export.findUniqueOrThrow({ where: { id: lost.id } })
      expect(gaveUp).toMatchObject({ status: ExportStatus.FAILED, error: ErrorCodes.EXPORT_FAILED })
    })
  })

  it('keeps going when the file of one expired export cannot be deleted', async () => {
    const make = async (): Promise<{ id: string; key: string }> => {
      const view = await request(ApiRoutes.customers.export)
      await made(view.id)
      const row = await owner.export.update({
        where: { id: view.id },
        data: { expiresAt: new Date(Date.now() - 1000) }
      })
      return { id: row.id, key: row.key ?? '' }
    }
    const stuck = await make()
    const fine = await make()
    const realDelete = storage.delete.bind(storage)
    const spy = jest.spyOn(storage, 'delete').mockImplementation(async key => {
      if (key === stuck.key) throw new Error('bucket refused')
      await realDelete(key)
    })

    await cleaner.run()
    spy.mockRestore()

    expect((await owner.export.findUniqueOrThrow({ where: { id: fine.id } })).status).toBe(
      ExportStatus.EXPIRED
    )
    expect((await owner.export.findUniqueOrThrow({ where: { id: stuck.id } })).status).toBe(
      ExportStatus.READY
    )
  })

  it('does not show a conversations export to who lost the permission to see conversations', async () => {
    const row = await owner.export.create({
      data: {
        storeId: ctx.storeA.id,
        requestedBy: ctx.agentA.id,
        type: ExportTypes.CONVERSATIONS,
        format: ExportFormats.CSV,
        status: ExportStatus.READY,
        expiresAt: new Date(Date.now() + 86_400_000)
      }
    })
    const role = await createRole(owner, {
      storeId: ctx.storeA.id,
      permissions: [Permissions.CONVERSATIONS_EXPORT, Permissions.MEDIA_DOWNLOAD_ALL]
    })
    const member = await createActor(owner, app, {
      prefix,
      name: 'export-only',
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA.id,
      roleId: role.id
    })
    await owner.export.update({ where: { id: row.id }, data: { requestedBy: member.id } })

    const response = await api(app, member, ctx.storeA).get(ApiRoutes.exports.byId(row.id))

    expect(response.status).toBe(NOT_FOUND)
  })

  it('leaves no half of a file at the key when the source fails half way', async () => {
    const key = `stores/${ctx.storeA.id}/exports/${randomUUID()}/half.csv`
    const writer = new CsvExportWriter(storage)

    await expect(
      writer.write(key, {
        columns: ['a'],
        rows: async function* () {
          yield ['one']
          await Promise.resolve()
          throw new Error('the database went away')
        }
      })
    ).rejects.toThrow('the database went away')

    expect(await storage.head(key)).toBeNull()
  })

  it('leaves the id of a random export a 404', async () => {
    const response = await asAdmin().get(ApiRoutes.exports.byId(randomUUID()))
    expect(response.status).toBe(NOT_FOUND)
  })
})
