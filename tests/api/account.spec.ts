import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { RoleNames } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import { MediaStatus } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { JobNames, QueueNames } from '@platform/core/queues'
import { AvatarProcessing, AvatarUpload, MediaPurpose, StorageKeys } from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'

import { createTestApp } from '../helpers/app'
import { createActor, seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { anonymousApi, api, apiWithoutStore } from '../helpers/http'
import { queueOf } from '../helpers/queue'

interface ProfileBody {
  id: string
  email: string
  name: string
  avatarMediaId: string | null
  avatarUrl: string | null
}
interface PreferencesBody {
  locale: string
  timezone: string | null
  density: string
}
interface UploadUrlBody {
  uploadUrl: string
  key: string
  mediaId: string
}
interface ErrorBody {
  error: { code: string; metadata?: Record<string, unknown> }
}

const OK = 200
const BAD_REQUEST = 400
const UNAUTHORIZED = 401
const FORBIDDEN = 403
const NOT_FOUND = 404
const TOO_MANY_REQUESTS = 429

// 1x1 transparent PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
)

describe('The account of a person', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let storage: StorageService
  const objects = new Set<string>()

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    storage = app.get(StorageService, { strict: false })
    ctx = await seedTestContext(owner, app, prefix)
  })
  afterAll(async () => {
    await Promise.all([...objects].map(key => storage.delete(key)))
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const me = () => apiWithoutStore(app, ctx.agentA)
  const codeOf = (body: unknown) => (body as ErrorBody).error.code
  async function auditEntry(action: string, resourceId: string) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const entry = await owner.auditLog.findFirst({ where: { action, resourceId } })
      if (entry !== null) return entry
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    return null
  }

  describe('authentication', () => {
    it.each([
      ['get', ApiRoutes.account.profile],
      ['patch', ApiRoutes.account.profile],
      ['get', ApiRoutes.account.preferences],
      ['patch', ApiRoutes.account.preferences]
    ] as const)('%s %s demands an access token', async (method, path) => {
      const response = await anonymousApi(app)[method](path).send({})
      expect(response.status).toBe(UNAUTHORIZED)
    })

    it('needs no store: it belongs to the person', async () => {
      const response = await me().get(ApiRoutes.account.profile)
      expect(response.status).toBe(OK)
      expect(response.body).toMatchObject({
        id: ctx.agentA.id,
        email: ctx.agentA.email,
        avatarMediaId: null,
        avatarUrl: null
      })
    })

    it('does not cache what it answers', async () => {
      const response = await me().get(ApiRoutes.account.preferences)
      expect(response.headers['cache-control']).toBe('no-store')
    })
  })

  describe('the profile', () => {
    it('changes the name, trimmed, and audits which field and not its value', async () => {
      const response = await me().patch(ApiRoutes.account.profile).send({ name: '  Ana Pérez  ' })

      expect(response.status).toBe(OK)
      expect((response.body as ProfileBody).name).toBe('Ana Pérez')
      expect((await owner.user.findUniqueOrThrow({ where: { id: ctx.agentA.id } })).name).toBe(
        'Ana Pérez'
      )
      const entry = await auditEntry(AuditAction.ACCOUNT_PROFILE_UPDATED, ctx.agentA.id)
      expect(entry?.metadata).toEqual({ fields: ['name'] })
      expect(JSON.stringify(entry)).not.toContain('Ana')
    })

    it('changes only the account of the token, never another one', async () => {
      const before = await owner.user.findUniqueOrThrow({ where: { id: ctx.viewerA.id } })

      const changed = await me().patch(ApiRoutes.account.profile).send({ name: 'Someone Else' })
      expect(changed.status).toBe(OK)
      expect((changed.body as ProfileBody).name).toBe('Someone Else')

      const after = await owner.user.findUniqueOrThrow({ where: { id: ctx.viewerA.id } })
      expect(after.name).toBe(before.name)
      expect(after.updatedAt).toEqual(before.updatedAt)
    })

    it.each([
      ['nothing to change', {}],
      ['an empty name', { name: '   ' }],
      ['a name over the limit', { name: 'x'.repeat(101) }],
      ['a name with a line break', { name: 'Ana\nPérez' }],
      ['an id in the body', { id: randomUUID(), name: 'Ana' }],
      ['an email in the body', { email: 'other@example.com' }],
      ['an avatar that is not an id', { avatarMediaId: 'not-an-id' }]
    ])('refuses %s', async (_name, body) => {
      const response = await me().patch(ApiRoutes.account.profile).send(body)
      expect(response.status).toBe(BAD_REQUEST)
      expect(codeOf(response.body)).toBe(ErrorCodes.VALIDATION_FAILED)
    })
  })

  describe('the preferences', () => {
    it('changes locale, timezone and density, and reads them back', async () => {
      const response = await me()
        .patch(ApiRoutes.account.preferences)
        .send({ locale: 'en', timezone: 'America/Bogota', density: 'compact' })

      expect(response.status).toBe(OK)
      expect(response.body).toEqual({
        locale: 'en',
        timezone: 'America/Bogota',
        density: 'compact'
      })
      const read = await me().get(ApiRoutes.account.preferences)
      expect(read.body).toEqual(response.body)
      const entry = await auditEntry(AuditAction.ACCOUNT_PREFERENCES_UPDATED, ctx.agentA.id)
      expect(entry?.metadata).toEqual({ fields: ['locale', 'timezone', 'density'] })
    })

    it('keeps what the request does not name, and null takes the timezone away', async () => {
      await me()
        .patch(ApiRoutes.account.preferences)
        .send({ locale: 'en', timezone: 'America/Bogota', density: 'compact' })
      const response = await me().patch(ApiRoutes.account.preferences).send({ timezone: null })

      expect(response.body).toEqual({ locale: 'en', timezone: null, density: 'compact' })
    })

    it('stores a timezone in its canonical spelling', async () => {
      const response = await me()
        .patch(ApiRoutes.account.preferences)
        .send({ timezone: 'america/bogota' })
      expect((response.body as PreferencesBody).timezone).toBe('America/Bogota')
    })

    it.each([
      ['nothing to change', {}],
      ['a locale the app has no messages for', { locale: 'pt-BR' }],
      ['a locale that is not one', { locale: 'xx' }],
      ['a timezone that is not one', { timezone: 'Mars/Olympus' }],
      ['a density that is not one', { density: 'huge' }],
      ['a field it does not know', { avatarMediaId: randomUUID() }]
    ])('refuses %s', async (_name, body) => {
      const response = await me().patch(ApiRoutes.account.preferences).send(body)
      expect(response.status).toBe(BAD_REQUEST)
      expect(codeOf(response.body)).toBe(ErrorCodes.VALIDATION_FAILED)
    })
  })

  describe('the avatar', () => {
    // The routes of the avatar need no store: nobody sends X-Store-Id here
    const requestUpload = (as = me(), overrides: Record<string, unknown> = {}) =>
      as.post(ApiRoutes.account.avatarUploadUrl).send({
        filename: 'me.png',
        contentType: 'image/png',
        fileSizeBytes: PNG.length,
        ...overrides
      })
    const confirmBody = (upload: UploadUrlBody, overrides: Record<string, unknown> = {}) => ({
      mediaId: upload.mediaId,
      key: upload.key,
      filename: 'me.png',
      contentType: 'image/png',
      fileSizeBytes: PNG.length,
      ...overrides
    })
    const put = (url: string, body: Buffer) =>
      fetch(url, {
        method: 'PUT',
        headers: { 'content-type': 'image/png', 'content-length': String(body.length) },
        body: new Uint8Array(body)
      })

    // An avatar uploaded and confirmed the way a client does it
    async function uploadAvatar(as = me(), userId = ctx.agentA.id) {
      const upload = (await requestUpload(as)).body as UploadUrlBody
      objects.add(upload.key)
      objects.add(StorageKeys.avatar(userId, upload.mediaId, 'me.png'))
      expect((await put(upload.uploadUrl, PNG)).status).toBe(OK)
      const confirmed = await as.post(ApiRoutes.account.avatarConfirm).send(confirmBody(upload))
      expect(confirmed.status).toBe(OK)
      expect(confirmed.body).toEqual({ mediaId: upload.mediaId, status: MediaStatus.PENDING })
      return upload
    }

    it('refuses an HTML page declared as image/png and keeps nothing of it', async () => {
      const page = Buffer.from('<html><script>alert(1)</script></html>')
      const upload = (await requestUpload(me(), { fileSizeBytes: page.length }))
        .body as UploadUrlBody
      objects.add(upload.key)
      objects.add(StorageKeys.avatar(ctx.agentA.id, upload.mediaId, 'me.png'))
      expect((await put(upload.uploadUrl, page)).status).toBe(OK)

      const response = await me()
        .post(ApiRoutes.account.avatarConfirm)
        .send(confirmBody(upload, { fileSizeBytes: page.length }))

      expect(response.status).toBe(BAD_REQUEST)
      expect(codeOf(response.body)).toBe(ErrorCodes.FILE_TYPE_NOT_ALLOWED)
      expect(await owner.media.count({ where: { id: upload.mediaId } })).toBe(0)
      // The refused file is not kept: its signed url is still writable
      expect(await storage.head(upload.key)).toBeNull()
    })

    it('is uploaded under the user and belongs to no store', async () => {
      const upload = await uploadAvatar()

      expect(upload.key).toBe(StorageKeys.avatarUpload(ctx.agentA.id, upload.mediaId, 'me.png'))
      const row = await owner.media.findUniqueOrThrow({ where: { id: upload.mediaId } })
      expect(row).toMatchObject({
        storeId: null,
        purpose: MediaPurpose.AVATAR,
        uploadedBy: ctx.agentA.id,
        key: StorageKeys.avatar(ctx.agentA.id, upload.mediaId, 'me.png'),
        status: MediaStatus.PENDING
      })
      // The staging copy is gone and the file is scanned before anything serves it
      expect(await storage.head(upload.key)).toBeNull()
      expect(
        queueOf(app, QueueNames.HEAVY_PROCESSING).jobs.some(
          job =>
            job.name === JobNames.SCAN_FILE &&
            (job.data as { mediaId: string }).mediaId === upload.mediaId
        )
      ).toBe(true)
    })

    it('confirming twice answers with the same media', async () => {
      const upload = await uploadAvatar()
      const again = await me().post(ApiRoutes.account.avatarConfirm).send(confirmBody(upload))
      expect(again.status).toBe(OK)
      expect((again.body as { mediaId: string }).mediaId).toBe(upload.mediaId)
    })

    it('becomes the picture, shown only once it is scanned clean and re-encoded', async () => {
      const upload = await uploadAvatar()

      const set = await me()
        .patch(ApiRoutes.account.profile)
        .send({ avatarMediaId: upload.mediaId })
      expect(set.status).toBe(OK)
      expect(set.body).toMatchObject({ avatarMediaId: upload.mediaId, avatarUrl: null })

      // Clean is not enough: the file is the one uploaded, with its metadata, until the worker has
      // re-encoded it (that step is tested against the real pipeline in the worker's suite)
      await owner.media.update({
        where: { id: upload.mediaId },
        data: { status: MediaStatus.CLEAN }
      })
      const scanned = (await me().get(ApiRoutes.account.profile)).body as ProfileBody
      expect(scanned).toMatchObject({ avatarMediaId: upload.mediaId, avatarUrl: null })

      await owner.media.update({ where: { id: upload.mediaId }, data: { processedAt: new Date() } })
      const clean = (await me().get(ApiRoutes.account.profile)).body as ProfileBody
      expect(clean.avatarUrl).not.toBeNull()
      const served = await fetch(clean.avatarUrl ?? '')
      expect(served.status).toBe(OK)
      expect(Buffer.from(await served.arrayBuffer())).toEqual(PNG)
    })

    it('replaces the one before, whose row and file go', async () => {
      const first = await uploadAvatar()
      await me().patch(ApiRoutes.account.profile).send({ avatarMediaId: first.mediaId })
      const second = await uploadAvatar()

      await me().patch(ApiRoutes.account.profile).send({ avatarMediaId: second.mediaId })

      expect(await owner.media.findUnique({ where: { id: first.mediaId } })).toBeNull()
      expect(
        await storage.head(StorageKeys.avatar(ctx.agentA.id, first.mediaId, 'me.png'))
      ).toBeNull()
      expect(await owner.media.findUnique({ where: { id: second.mediaId } })).not.toBeNull()
      const profile = (await me().get(ApiRoutes.account.profile)).body as ProfileBody
      expect(profile.avatarMediaId).toBe(second.mediaId)
    })

    it('reads as no picture once the scan refused it, instead of naming an id that never shows', async () => {
      const upload = await uploadAvatar()
      await me().patch(ApiRoutes.account.profile).send({ avatarMediaId: upload.mediaId })
      await owner.media.update({
        where: { id: upload.mediaId },
        data: { status: MediaStatus.INFECTED }
      })

      const profile = (await me().get(ApiRoutes.account.profile)).body as ProfileBody

      expect(profile).toMatchObject({ avatarMediaId: null, avatarUrl: null })
    })

    it('is taken away with null, row and file, and audited without the id', async () => {
      const upload = await uploadAvatar()
      await me().patch(ApiRoutes.account.profile).send({ avatarMediaId: upload.mediaId })

      const response = await me().patch(ApiRoutes.account.profile).send({ avatarMediaId: null })

      expect(response.body).toMatchObject({ avatarMediaId: null, avatarUrl: null })
      expect(await owner.media.findUnique({ where: { id: upload.mediaId } })).toBeNull()
      expect(
        await storage.head(StorageKeys.avatar(ctx.agentA.id, upload.mediaId, 'me.png'))
      ).toBeNull()
      const entry = await auditEntry(AuditAction.ACCOUNT_PROFILE_UPDATED, ctx.agentA.id)
      expect(entry).not.toBeNull()
      expect(JSON.stringify(entry?.metadata)).not.toContain(upload.mediaId)
    })

    it('is refused as a type or a size an avatar may not be, saying the limit', async () => {
      const gif = await requestUpload(me(), { contentType: 'image/gif' })
      expect(gif.status).toBe(BAD_REQUEST)
      expect(codeOf(gif.body)).toBe(ErrorCodes.FILE_TYPE_NOT_ALLOWED)

      const big = await requestUpload(me(), { fileSizeBytes: AvatarUpload.MAX_SIZE_BYTES + 1 })
      expect(big.status).toBe(BAD_REQUEST)
      expect(codeOf(big.body)).toBe(ErrorCodes.FILE_TOO_LARGE)
      expect((big.body as ErrorBody).error.metadata).toEqual({
        maxSizeBytes: AvatarUpload.MAX_SIZE_BYTES
      })
    })

    it('is set by a viewer, who holds no permission to upload to the store', async () => {
      const viewer = apiWithoutStore(app, ctx.viewerA)
      const upload = await uploadAvatar(viewer, ctx.viewerA.id)

      const response = await viewer
        .patch(ApiRoutes.account.profile)
        .send({ avatarMediaId: upload.mediaId })

      expect(response.status).toBe(OK)
      expect(response.body).toMatchObject({ avatarMediaId: upload.mediaId })
    })

    it('holds a person to a few avatar rows at once', async () => {
      const heavy = await createActor(owner, app, {
        prefix,
        name: 'avatarRows',
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        roleId: ctx.roleIds[RoleNames.AGENT]
      })
      const asHeavy = apiWithoutStore(app, heavy)
      for (let held = 0; held < AvatarProcessing.MAX_ROWS_PER_USER; held += 1) {
        await uploadAvatar(asHeavy, heavy.id)
      }
      const upload = (await requestUpload(asHeavy)).body as UploadUrlBody
      objects.add(upload.key)
      await put(upload.uploadUrl, PNG)

      const over = await asHeavy.post(ApiRoutes.account.avatarConfirm).send(confirmBody(upload))

      expect(over.status).toBe(TOO_MANY_REQUESTS)
      expect(await owner.media.findUnique({ where: { id: upload.mediaId } })).toBeNull()
    })

    it('is not a purpose of the media routes of a store any more', async () => {
      const response = await api(app, ctx.agentA, ctx.storeA).post(ApiRoutes.media.uploadUrl).send({
        purpose: MediaPurpose.AVATAR,
        filename: 'me.png',
        contentType: 'image/png',
        fileSizeBytes: PNG.length
      })
      expect(response.status).toBe(BAD_REQUEST)
    })

    it('needs a signed in person and takes nothing from the body but the file', async () => {
      const anonymous = await anonymousApi(app).post(ApiRoutes.account.avatarUploadUrl).send({})
      expect(anonymous.status).toBe(UNAUTHORIZED)
      const extra = await requestUpload(me(), { userId: randomUUID() })
      expect(extra.status).toBe(BAD_REQUEST)
    })

    it('is limited per person and hour, and uses none of the quota of the store', async () => {
      const heavy = await createActor(owner, app, {
        prefix,
        name: 'avatarQuota',
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        roleId: ctx.roleIds[RoleNames.AGENT]
      })
      const asHeavy = apiWithoutStore(app, heavy)
      for (let asked = 0; asked < AvatarProcessing.SIGNED_URLS_PER_USER_PER_HOUR; asked += 1) {
        expect((await requestUpload(asHeavy)).status).toBe(OK)
      }

      const over = await requestUpload(asHeavy)

      expect(over.status).toBe(TOO_MANY_REQUESTS)
      expect(codeOf(over.body)).toBe(ErrorCodes.RATE_LIMIT_EXCEEDED)
      // Another person is not held back by it
      const other = await createActor(owner, app, {
        prefix,
        name: 'avatarQuotaOther',
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        roleId: ctx.roleIds[RoleNames.AGENT]
      })
      expect((await requestUpload(apiWithoutStore(app, other))).status).toBe(OK)
    })

    describe("someone else's, or not an avatar at all", () => {
      let other: Awaited<ReturnType<typeof createActor>>
      beforeAll(async () => {
        other = await createActor(owner, app, {
          prefix,
          name: 'otherAgent',
          organizationId: ctx.orgA.id,
          storeId: ctx.storeA.id,
          roleId: ctx.roleIds[RoleNames.AGENT]
        })
      })

      it('cannot be confirmed by another user with the key of the first', async () => {
        const upload = (await requestUpload()).body as UploadUrlBody
        objects.add(upload.key)
        await put(upload.uploadUrl, PNG)

        const response = await apiWithoutStore(app, other)
          .post(ApiRoutes.account.avatarConfirm)
          .send(confirmBody(upload))

        expect(response.status).toBe(FORBIDDEN)
        expect(codeOf(response.body)).toBe(ErrorCodes.FILE_KEY_OUT_OF_SCOPE)
        expect(await owner.media.findUnique({ where: { id: upload.mediaId } })).toBeNull()
      })

      it('cannot be confirmed with the key of a file of the store', async () => {
        const upload = (await requestUpload()).body as UploadUrlBody
        objects.add(upload.key)
        await put(upload.uploadUrl, PNG)

        const response = await me()
          .post(ApiRoutes.account.avatarConfirm)
          .send(
            confirmBody(upload, {
              key: StorageKeys.messageUpload(ctx.storeA.id, upload.mediaId, 'me.png')
            })
          )

        expect(response.status).toBe(FORBIDDEN)
        expect(codeOf(response.body)).toBe(ErrorCodes.FILE_KEY_OUT_OF_SCOPE)
      })

      it('cannot be confirmed before the file is there, or with another size or type', async () => {
        const upload = (await requestUpload()).body as UploadUrlBody
        const missing = await me().post(ApiRoutes.account.avatarConfirm).send(confirmBody(upload))
        expect(missing.status).toBe(BAD_REQUEST)
        expect(codeOf(missing.body)).toBe(ErrorCodes.FILE_UPLOAD_FAILED)

        objects.add(upload.key)
        await put(upload.uploadUrl, PNG)
        const lying = await me()
          .post(ApiRoutes.account.avatarConfirm)
          .send(confirmBody(upload, { fileSizeBytes: PNG.length + 1 }))
        expect(lying.status).toBe(BAD_REQUEST)
        expect(await owner.media.findUnique({ where: { id: upload.mediaId } })).toBeNull()
      })

      it('cannot become the picture of another user', async () => {
        const upload = await uploadAvatar()

        const response = await apiWithoutStore(app, other)
          .patch(ApiRoutes.account.profile)
          .send({ avatarMediaId: upload.mediaId })

        expect(response.status).toBe(NOT_FOUND)
        expect(
          (await owner.user.findUniqueOrThrow({ where: { id: other.id } })).avatarMediaId
        ).toBeNull()
      })

      it.each([
        ['an id that does not exist', () => randomUUID()],
        [
          'a file of a message',
          async () => {
            const id = randomUUID()
            await owner.media.create({
              data: {
                id,
                storeId: ctx.storeA.id,
                purpose: MediaPurpose.MESSAGE,
                uploadedBy: ctx.agentA.id,
                key: StorageKeys.message(ctx.storeA.id, id, 'm.png'),
                filename: 'm.png',
                contentType: 'image/png',
                fileSize: 1,
                status: MediaStatus.CLEAN
              }
            })
            return id
          }
        ],
        [
          'an avatar the scan found infected',
          async () => {
            const upload = await uploadAvatar()
            await owner.media.update({
              where: { id: upload.mediaId },
              data: { status: MediaStatus.INFECTED }
            })
            return upload.mediaId
          }
        ]
      ])('cannot be %s', async (_name, make) => {
        const mediaId = await make()

        const response = await me()
          .patch(ApiRoutes.account.profile)
          .send({ avatarMediaId: mediaId })

        expect(response.status).toBe(NOT_FOUND)
        expect(codeOf(response.body)).toBe(ErrorCodes.RESOURCE_NOT_FOUND)
      })
    })
  })
})
