import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import { unzipSync } from 'fflate'
import type { PinoLogger } from 'nestjs-pino'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { type Permission, Permissions } from '@platform/core/auth'
import { PrismaService } from '@platform/core/database'
import type { OwnerClient } from '@platform/core/database-testing'
import { ChannelType, ConversationStatus } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import {
  ExportFormats,
  ExportStatus,
  ExportTypes,
  JobNames,
  QueueNames
} from '@platform/core/queues'
import { GalleryLimits, StorageKeys } from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'

import { CsvExportWriter } from '../../apps/worker/src/exports/csv-export-writer'
import { ExportGenerator } from '../../apps/worker/src/exports/export-generator.service'
import { ZipExportWriter } from '../../apps/worker/src/exports/zip-export-writer'
import {
  createConversation,
  createConversationOf,
  createCustomer,
  createMessage
} from '../builders'
import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { type Actor, api } from '../helpers/http'
import { queueOf } from '../helpers/queue'

interface ErrorBody {
  error: { code: string }
}
interface GalleryBody {
  data: {
    id: string
    type: string | null
    filename: string
    contentType: string
    fileSizeBytes: number
    channelType: string | null
    key?: unknown
    url?: unknown
  }[]
  counts: Record<string, number> | null
  nextCursor: string | null
  hasMore: boolean
}
interface ExportBody {
  id: string
  type: string
  format: string
  status: string
}
interface DownloadBody {
  url: string
  filename: string
}

const OK = 200
const ACCEPTED = 202
const BAD_REQUEST = 400
const FORBIDDEN = 403
const NOT_FOUND = 404
const MAX_ZIP = 5_000_000

// The gallery of a customer and "Download all", from the request to the ZIP: the api makes the row,
// the generator of the worker (run here by hand, as the worker would) streams the files from the bucket.
describe('Media gallery', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let storage: StorageService
  let generator: ExportGenerator
  let warn: jest.Mock
  const keys: string[] = []

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    storage = app.get(StorageService, { strict: false })
    warn = jest.fn()
    const logger = { setContext: jest.fn(), error: jest.fn(), warn } as unknown as PinoLogger
    generator = new ExportGenerator(
      app.get(PrismaService, { strict: false }),
      new CsvExportWriter(storage),
      new ZipExportWriter(storage, logger),
      storage,
      app.get(AuditService, { strict: false }),
      logger
    )
  })
  afterAll(async () => {
    for (const key of keys) await storage.delete(key)
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })
  afterEach(async () => {
    await owner.export.updateMany({
      where: { storeId: { in: [ctx.storeA.id, ctx.storeB.id] }, status: ExportStatus.PENDING },
      data: { status: ExportStatus.FAILED }
    })
  })

  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)

  interface FileInput {
    storeId?: string
    customerId: string
    messageId?: string
    filename: string
    contentType?: string
    status?: string
    fileSize?: number
    createdAt?: Date
    // The bytes put in the bucket; none leaves the object missing
    body?: string
  }

  async function file(input: FileInput): Promise<{ id: string; key: string }> {
    const storeId = input.storeId ?? ctx.storeA.id
    const id = randomUUID()
    const key = StorageKeys.message(storeId, id, input.filename)
    const contentType = input.contentType ?? 'image/png'
    if (input.body !== undefined) {
      await storage.put(key, Buffer.from(input.body), contentType)
      keys.push(key)
    }
    await owner.media.create({
      data: {
        id,
        storeId,
        purpose: 'message',
        customerId: input.customerId,
        ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
        key,
        filename: input.filename,
        contentType,
        fileSize: input.fileSize ?? input.body?.length ?? 10,
        status: input.status ?? 'clean',
        ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt })
      }
    })
    return { id, key }
  }

  const at = (minutes: number) => new Date(Date.UTC(2026, 10, 1, 9, minutes))

  async function zipOf(exportId: string): Promise<Record<string, string>> {
    await generator.generate(exportId, false)
    const row = await owner.export.findUniqueOrThrow({ where: { id: exportId } })
    expect(row.status).toBe(ExportStatus.READY)
    const key = row.key ?? ''
    keys.push(key)
    const bytes = await storage.read(key, MAX_ZIP)
    return Object.fromEntries(
      Object.entries(unzipSync(new Uint8Array(bytes ?? Buffer.alloc(0)))).map(([name, data]) => [
        name,
        Buffer.from(data).toString('utf8')
      ])
    )
  }

  describe('GET /customers/:id/media', () => {
    it('needs the permission to see customers and the one to see files', async () => {
      const customer = await createCustomer(owner, { storeId: ctx.storeA.id })
      const base = { prefix, organizationId: ctx.orgA.id, storeId: ctx.storeA.id }
      const onlyCustomers = await actorWithPermissions(owner, app, {
        ...base,
        name: 'gallery-customers',
        permissions: [Permissions.CUSTOMERS_VIEW]
      })
      const onlyFiles = await actorWithPermissions(owner, app, {
        ...base,
        name: 'gallery-files',
        permissions: [Permissions.MEDIA_VIEW]
      })
      const both = await actorWithPermissions(owner, app, {
        ...base,
        name: 'gallery-both',
        permissions: [Permissions.CUSTOMERS_VIEW, Permissions.MEDIA_VIEW]
      })

      const path = ApiRoutes.customers.media(customer.id)
      expect((await api(app, onlyCustomers, ctx.storeA).get(path)).status).toBe(FORBIDDEN)
      expect((await api(app, onlyFiles, ctx.storeA).get(path)).status).toBe(FORBIDDEN)
      expect((await api(app, both, ctx.storeA).get(path)).status).toBe(OK)
    })

    it('lists the clean files newest first with the count of each tab, and never a link or a key', async () => {
      const customer = await createCustomer(owner, { storeId: ctx.storeA.id })
      const conversation = await createConversationOf(owner, {
        storeId: ctx.storeA.id,
        channelType: ChannelType.WHATSAPP
      })
      const message = await createMessage(owner, {
        storeId: ctx.storeA.id,
        conversationId: conversation.id
      })
      const old = await file({ customerId: customer.id, filename: 'old.png', createdAt: at(1) })
      const recent = await file({
        customerId: customer.id,
        messageId: message.id,
        filename: 'recent.pdf',
        contentType: 'application/pdf',
        createdAt: at(3)
      })
      await file({
        customerId: customer.id,
        filename: 'clip.mp4',
        contentType: 'video/mp4',
        createdAt: at(2)
      })
      // Not offered: not scanned yet, infected, and the file of another customer
      await file({ customerId: customer.id, filename: 'pending.png', status: 'pending' })
      await file({ customerId: customer.id, filename: 'virus.png', status: 'infected' })
      const other = await createCustomer(owner, { storeId: ctx.storeA.id })
      await file({ customerId: other.id, filename: 'someone-else.png' })

      const response = await asAdmin().get(ApiRoutes.customers.media(customer.id))

      expect(response.status).toBe(OK)
      const body = response.body as GalleryBody
      expect(body.data.map(item => item.id)).toEqual([recent.id, expect.any(String), old.id])
      expect(body.data[0]).toMatchObject({
        type: 'document',
        filename: 'recent.pdf',
        channelType: ChannelType.WHATSAPP
      })
      expect(body.data[2]?.channelType).toBeNull()
      expect(body.counts).toEqual({ all: 3, image: 1, video: 1, audio: 0, document: 1 })
      for (const item of body.data) {
        expect(item.key).toBeUndefined()
        expect(item.url).toBeUndefined()
      }
    })

    it('filters by tab and by file name, counts the tabs under the search, and takes a % as text', async () => {
      const customer = await createCustomer(owner, { storeId: ctx.storeA.id })
      await file({ customerId: customer.id, filename: 'Zapato-rojo.png' })
      await file({
        customerId: customer.id,
        filename: 'zapato.pdf',
        contentType: 'application/pdf'
      })
      await file({ customerId: customer.id, filename: 'talla.png' })
      await file({ customerId: customer.id, filename: '100%.png' })
      const path = ApiRoutes.customers.media(customer.id)

      const tab = (await asAdmin().get(`${path}?type=image`)).body as GalleryBody
      expect(tab.data.map(item => item.filename).sort()).toEqual([
        '100%.png',
        'Zapato-rojo.png',
        'talla.png'
      ])

      const search = (await asAdmin().get(`${path}?q=zapato`)).body as GalleryBody
      expect(search.data.map(item => item.filename).sort()).toEqual([
        'Zapato-rojo.png',
        'zapato.pdf'
      ])
      expect(search.counts).toEqual({ all: 2, image: 1, video: 0, audio: 0, document: 1 })

      const both = (await asAdmin().get(`${path}?q=zapato&type=document`)).body as GalleryBody
      expect(both.data.map(item => item.filename)).toEqual(['zapato.pdf'])
      expect(both.counts?.all).toBe(2)

      const percent = (await asAdmin().get(`${path}?q=${encodeURIComponent('%')}`))
        .body as GalleryBody
      expect(percent.data.map(item => item.filename)).toEqual(['100%.png'])
    })

    it('pages with a cursor and refuses an unknown tab or filter', async () => {
      const customer = await createCustomer(owner, { storeId: ctx.storeA.id })
      for (const minute of [1, 2, 3]) {
        await file({ customerId: customer.id, filename: `p${minute}.png`, createdAt: at(minute) })
      }
      const path = ApiRoutes.customers.media(customer.id)

      const first = (await asAdmin().get(`${path}?limit=2`)).body as GalleryBody
      expect(first.data.map(item => item.filename)).toEqual(['p3.png', 'p2.png'])
      expect(first.hasMore).toBe(true)
      const second = (await asAdmin().get(`${path}?limit=2&cursor=${first.nextCursor ?? ''}`))
        .body as GalleryBody
      expect(second.data.map(item => item.filename)).toEqual(['p1.png'])
      expect(second.hasMore).toBe(false)
      // The counts are the whole gallery and come once, with the first page
      expect(first.counts?.all).toBe(3)
      expect(second.counts).toBeNull()

      expect((await asAdmin().get(`${path}?type=pdf`)).status).toBe(BAD_REQUEST)
      expect((await asAdmin().get(`${path}?storeId=${ctx.storeB.id}`)).status).toBe(BAD_REQUEST)
    })

    it('is a 404 for a customer of another store, for one that was absorbed and for none', async () => {
      const foreign = await createCustomer(owner, { storeId: ctx.storeB.id })
      const survivor = await createCustomer(owner, { storeId: ctx.storeA.id })
      const absorbed = await createCustomer(owner, { storeId: ctx.storeA.id })
      await owner.customer.update({
        where: { id: absorbed.id },
        data: { mergedIntoId: survivor.id }
      })
      for (const id of [foreign.id, absorbed.id, randomUUID()]) {
        const response = await asAdmin().get(ApiRoutes.customers.media(id))
        expect(response.status).toBe(NOT_FOUND)
      }
    })

    it('does not list a file of another store that names this customer', async () => {
      const customer = await createCustomer(owner, { storeId: ctx.storeA.id })
      await file({ customerId: customer.id, filename: 'mine.png' })
      // A row that should not exist (the customer is of store A) but must still not cross
      await owner.media.create({
        data: {
          storeId: ctx.storeB.id,
          purpose: 'message',
          customerId: customer.id,
          key: StorageKeys.message(ctx.storeB.id, randomUUID(), 'theirs.png'),
          filename: 'theirs.png',
          contentType: 'image/png',
          fileSize: 10,
          status: 'clean'
        }
      })

      const body = (await asAdmin().get(ApiRoutes.customers.media(customer.id))).body as GalleryBody

      expect(body.data.map(item => item.filename)).toEqual(['mine.png'])
      expect(body.counts?.all).toBe(1)
    })
  })

  describe('what the viewer may open', () => {
    // One customer with a file in each kind of conversation: free, assigned to the admin, archived,
    // and a file with no message
    async function scene() {
      const base = { storeId: ctx.storeA.id, channelType: ChannelType.WHATSAPP }
      const free = await createConversationOf(owner, base)
      const customerId = free.customerId
      const identity = free.customerIdentityId
      const make = async (data: { assignedTo?: string; status?: ConversationStatus }) => {
        const conversation = await createConversation(owner, {
          ...base,
          customerId,
          customerIdentityId: identity,
          ...data
        })
        return createMessage(owner, { storeId: ctx.storeA.id, conversationId: conversation.id })
      }
      const freeMessage = await createMessage(owner, {
        storeId: ctx.storeA.id,
        conversationId: free.id
      })
      const taken = await make({ assignedTo: ctx.adminA.id })
      const archived = await make({ status: ConversationStatus.ARCHIVED })
      await file({ customerId, messageId: freeMessage.id, filename: 'free.png', body: 'f' })
      await file({ customerId, messageId: taken.id, filename: 'taken.png', body: 't' })
      await file({ customerId, messageId: archived.id, filename: 'archived.png', body: 'a' })
      await file({ customerId, filename: 'loose.png', body: 'l' })
      return customerId
    }
    const member = (name: string, extra: Permission[]) =>
      actorWithPermissions(owner, app, {
        prefix,
        name,
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        permissions: [
          Permissions.CUSTOMERS_VIEW,
          Permissions.MEDIA_VIEW,
          Permissions.MEDIA_DOWNLOAD_ALL,
          ...extra
        ]
      })

    it('lists the files of conversations nobody else holds, and only those, to who sees no more', async () => {
      const customerId = await scene()
      const limited = await member('vis-limited', [Permissions.CONVERSATIONS_VIEW])

      const response = await api(app, limited, ctx.storeA).get(
        ApiRoutes.customers.media(customerId)
      )

      const body = response.body as GalleryBody
      expect(body.data.map(item => item.filename)).toEqual(['free.png'])
      expect(body.counts?.all).toBe(1)
    })

    it('lists everything but what is hidden to who sees all, and all of it to who may also archive', async () => {
      const customerId = await scene()
      const all = await member('vis-all', [
        Permissions.CONVERSATIONS_VIEW,
        Permissions.CONVERSATIONS_VIEW_ALL
      ])
      const everything = await member('vis-everything', [
        Permissions.CONVERSATIONS_VIEW,
        Permissions.CONVERSATIONS_VIEW_ALL,
        Permissions.CONVERSATIONS_ARCHIVE
      ])
      const names = async (actor: Actor) =>
        (
          (await api(app, actor, ctx.storeA).get(ApiRoutes.customers.media(customerId)))
            .body as GalleryBody
        ).data
          .map(item => item.filename)
          .sort()

      expect(await names(all)).toEqual(['free.png', 'taken.png'])
      expect(await names(everything)).toEqual([
        'archived.png',
        'free.png',
        'loose.png',
        'taken.png'
      ])
    })

    it('shows nothing to who may not see conversations at all', async () => {
      const customerId = await scene()
      const blind = await member('vis-blind', [])

      const response = await api(app, blind, ctx.storeA).get(ApiRoutes.customers.media(customerId))

      expect((response.body as GalleryBody).data).toEqual([])
      const zip = await api(app, blind, ctx.storeA)
        .post(ApiRoutes.media.downloadAll)
        .send({ customerId })
      expect((zip.body as ErrorBody).error.code).toBe(ErrorCodes.EXPORT_EMPTY)
    })

    it('zips only what the requester could open when they asked', async () => {
      const customerId = await scene()
      const limited = await member('vis-zip', [Permissions.CONVERSATIONS_VIEW])
      const requested = await api(app, limited, ctx.storeA)
        .post(ApiRoutes.media.downloadAll)
        .send({ customerId })
      expect(requested.status).toBe(ACCEPTED)

      expect(Object.keys(await zipOf((requested.body as ExportBody).id))).toEqual(['free.png'])
    })
  })

  describe('POST /media/download-all', () => {
    const download = (body: object) => asAdmin().post(ApiRoutes.media.downloadAll).send(body)

    it('needs the three permissions, and nobody gets it without all of them', async () => {
      const customer = await createCustomer(owner, { storeId: ctx.storeA.id })
      await file({ customerId: customer.id, filename: 'a.png' })
      const base = { prefix, organizationId: ctx.orgA.id, storeId: ctx.storeA.id }
      const missing = [
        [Permissions.MEDIA_VIEW, Permissions.MEDIA_DOWNLOAD_ALL],
        [Permissions.CUSTOMERS_VIEW, Permissions.MEDIA_DOWNLOAD_ALL],
        [Permissions.CUSTOMERS_VIEW, Permissions.MEDIA_VIEW]
      ]
      for (const [index, permissions] of missing.entries()) {
        const actor = await actorWithPermissions(owner, app, {
          ...base,
          name: `zip-missing-${index}`,
          permissions
        })
        const response = await api(app, actor, ctx.storeA)
          .post(ApiRoutes.media.downloadAll)
          .send({ customerId: customer.id })
        expect(response.status).toBe(FORBIDDEN)
      }
      expect(
        (
          await api(app, ctx.agentA, ctx.storeA)
            .post(ApiRoutes.media.downloadAll)
            .send({ customerId: customer.id })
        ).status
      ).toBe(FORBIDDEN)
    })

    it('queues the job and answers with the export, keeping the tab and the search', async () => {
      const customer = await createCustomer(owner, { storeId: ctx.storeA.id })
      await file({ customerId: customer.id, filename: 'zapato.png' })

      const response = await download({ customerId: customer.id, type: 'image', q: 'zapato' })

      expect(response.status).toBe(ACCEPTED)
      const view = response.body as ExportBody
      expect(view).toMatchObject({
        type: ExportTypes.MEDIA_ZIP,
        format: ExportFormats.ZIP,
        status: ExportStatus.PENDING
      })
      const row = await owner.export.findUniqueOrThrow({ where: { id: view.id } })
      expect(row).toMatchObject({
        storeId: ctx.storeA.id,
        requestedBy: ctx.adminA.id,
        filters: { customerId: customer.id, type: 'image', q: 'zapato' }
      })
      expect(queueOf(app, QueueNames.EXPORTS).jobs).toContainEqual({
        name: JobNames.GENERATE_EXPORT,
        data: { exportId: view.id },
        opts: { jobId: `${JobNames.GENERATE_EXPORT}-${view.id}` }
      })
    })

    it('refuses a body it does not know, a customer of another store and a customer with no files', async () => {
      const customer = await createCustomer(owner, { storeId: ctx.storeA.id })
      const foreign = await createCustomer(owner, { storeId: ctx.storeB.id })
      await file({ storeId: ctx.storeB.id, customerId: foreign.id, filename: 'b.png' })
      const before = await owner.export.count({ where: { storeId: ctx.storeA.id } })

      expect((await download({ customerId: customer.id, storeId: ctx.storeB.id })).status).toBe(
        BAD_REQUEST
      )
      expect((await download({ customerId: customer.id, type: 'zip' })).status).toBe(BAD_REQUEST)
      expect((await download({})).status).toBe(BAD_REQUEST)
      expect((await download({ customerId: foreign.id })).status).toBe(NOT_FOUND)
      const empty = await download({ customerId: customer.id })
      expect(empty.status).toBe(BAD_REQUEST)
      expect((empty.body as ErrorBody).error.code).toBe(ErrorCodes.EXPORT_EMPTY)

      expect(await owner.export.count({ where: { storeId: ctx.storeA.id } })).toBe(before)
    })

    it('refuses more files, or more bytes, than a ZIP may hold', async () => {
      const heavy = await createCustomer(owner, { storeId: ctx.storeA.id })
      await file({
        customerId: heavy.id,
        filename: 'huge.mp4',
        contentType: 'video/mp4',
        fileSize: GalleryLimits.ZIP_MAX_BYTES + 1
      })
      const many = await createCustomer(owner, { storeId: ctx.storeA.id })
      await owner.media.createMany({
        data: Array.from({ length: GalleryLimits.ZIP_MAX_FILES + 1 }, (_, index) => ({
          storeId: ctx.storeA.id,
          purpose: 'message',
          customerId: many.id,
          key: StorageKeys.message(ctx.storeA.id, randomUUID(), `f${index}.png`),
          filename: `f${index}.png`,
          contentType: 'image/png',
          fileSize: 1,
          status: 'clean'
        }))
      })

      for (const customerId of [heavy.id, many.id]) {
        const response = await download({ customerId })
        expect(response.status).toBe(BAD_REQUEST)
        expect((response.body as ErrorBody).error.code).toBe(ErrorCodes.EXPORT_TOO_LARGE)
      }
    })

    it('makes a ZIP of the clean files the gallery shows, names the repeated ones apart and audits it', async () => {
      const customer = await createCustomer(owner, { storeId: ctx.storeA.id })
      await file({ customerId: customer.id, filename: 'photo.png', body: 'one' })
      await file({ customerId: customer.id, filename: 'photo.png', body: 'two' })
      await file({
        customerId: customer.id,
        filename: 'receipt.pdf',
        contentType: 'application/pdf',
        body: 'pdf '.repeat(50)
      })
      await file({ customerId: customer.id, filename: 'hidden.png', status: 'infected', body: 'x' })
      await file({ customerId: customer.id, filename: 'waiting.png', status: 'pending', body: 'x' })
      await file({
        customerId: customer.id,
        filename: 'other-store.png',
        storeId: ctx.storeB.id,
        body: 'x'
      })
      const view = (await download({ customerId: customer.id })).body as ExportBody

      const entries = await zipOf(view.id)

      expect(Object.keys(entries).sort()).toEqual(['photo (2).png', 'photo.png', 'receipt.pdf'])
      expect([entries['photo.png'], entries['photo (2).png']].sort()).toEqual(['one', 'two'])
      expect(entries['receipt.pdf']).toBe('pdf '.repeat(50))
      const row = await owner.export.findUniqueOrThrow({ where: { id: view.id } })
      expect(row.rowCount).toBe(3)
      expect(row.key).toMatch(/\.zip$/)
      const [entry] = await waitForAuditEntries(owner, {
        action: AuditAction.MEDIA_BULK_DOWNLOADED,
        resourceId: view.id
      })
      expect(entry).toMatchObject({ userId: ctx.adminA.id, storeId: ctx.storeA.id })
      expect(entry?.metadata).toMatchObject({ rowCount: 3, filters: { customerId: customer.id } })
    })

    it('holds only the tab and the search that were asked for', async () => {
      const customer = await createCustomer(owner, { storeId: ctx.storeA.id })
      await file({ customerId: customer.id, filename: 'zapato.png', body: 'a' })
      await file({ customerId: customer.id, filename: 'talla.png', body: 'b' })
      await file({
        customerId: customer.id,
        filename: 'zapato.pdf',
        contentType: 'application/pdf',
        body: 'c'
      })
      const view = (await download({ customerId: customer.id, type: 'image', q: 'ZAPATO' }))
        .body as ExportBody

      expect(Object.keys(await zipOf(view.id))).toEqual(['zapato.png'])
    })

    it('serves the ZIP through the exports center as an attachment of its own type', async () => {
      const customer = await createCustomer(owner, { storeId: ctx.storeA.id })
      await file({ customerId: customer.id, filename: 'a.png', body: 'a' })
      const view = (await download({ customerId: customer.id })).body as ExportBody
      await zipOf(view.id)

      const ready = await asAdmin().get(ApiRoutes.exports.download(view.id))

      expect(ready.status).toBe(OK)
      const { url, filename } = ready.body as DownloadBody
      expect(filename).toMatch(/^media_zip-\d{4}-\d{2}-\d{2}\.zip$/)
      const served = await fetch(url)
      expect(served.headers.get('content-type')).toContain('application/zip')
      expect(served.headers.get('content-disposition')).toContain('attachment')
      // A member who is not the requester does not see it
      const colleague = await actorWithPermissions(owner, app, {
        prefix,
        name: 'zip-colleague',
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        permissions: [
          Permissions.CUSTOMERS_VIEW,
          Permissions.MEDIA_VIEW,
          Permissions.MEDIA_DOWNLOAD_ALL
        ]
      })
      const other = await api(app, colleague, ctx.storeA).get(ApiRoutes.exports.byId(view.id))
      expect(other.status).toBe(NOT_FOUND)
    })

    it('leaves out a file that is gone from the bucket and keeps the rest', async () => {
      const customer = await createCustomer(owner, { storeId: ctx.storeA.id })
      await file({ customerId: customer.id, filename: 'here.png', body: 'here' })
      await file({ customerId: customer.id, filename: 'gone.png' })
      const view = (await download({ customerId: customer.id })).body as ExportBody

      const entries = await zipOf(view.id)

      // The ZIP says which file it could not include
      expect(entries).toEqual({ 'here.png': 'here', 'missing.txt': 'gone.png\n' })
      expect(warn).toHaveBeenCalled()
      expect((await owner.export.findUniqueOrThrow({ where: { id: view.id } })).rowCount).toBe(1)
    })

    it('fails for good, with its own code, when every file is gone and makes no empty ZIP', async () => {
      const customer = await createCustomer(owner, { storeId: ctx.storeA.id })
      await file({ customerId: customer.id, filename: 'gone.png' })
      const view = (await download({ customerId: customer.id })).body as ExportBody

      await expect(generator.generate(view.id, false)).rejects.toThrow('no files')

      const row = await owner.export.findUniqueOrThrow({ where: { id: view.id } })
      expect(row).toMatchObject({ status: ExportStatus.FAILED, error: ErrorCodes.EXPORT_EMPTY })
      const listed = await storage.list(StorageKeys.exportPrefix(ctx.storeA.id, view.id))
      expect(listed.objects).toEqual([])
    })

    it('fails for good when the files grew past the ceiling after the request, and leaves no file', async () => {
      const customer = await createCustomer(owner, { storeId: ctx.storeA.id })
      await file({ customerId: customer.id, filename: 'a.png', body: 'a' })
      const view = (await download({ customerId: customer.id })).body as ExportBody
      await file({
        customerId: customer.id,
        filename: 'late.mp4',
        contentType: 'video/mp4',
        fileSize: GalleryLimits.ZIP_MAX_BYTES
      })

      await expect(generator.generate(view.id, false)).rejects.toThrow('too many or too large')

      const row = await owner.export.findUniqueOrThrow({ where: { id: view.id } })
      expect(row).toMatchObject({
        status: ExportStatus.FAILED,
        error: ErrorCodes.EXPORT_TOO_LARGE,
        key: null
      })
      const listed = await storage.list(StorageKeys.exportPrefix(ctx.storeA.id, view.id))
      expect(listed.objects).toEqual([])
    })
  })
})
