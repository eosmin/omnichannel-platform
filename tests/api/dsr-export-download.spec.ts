import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { DsrExportDownloadThrottle, ThrottlerNames } from '@platform/core/auth'
import {
  ComplianceConfig,
  DSR_CONFIG,
  type DsrConfig,
  dsrEmailHash
} from '@platform/core/compliance'
import { encrypt, generateToken, hashToken, parseEncryptionKey } from '@platform/core/crypto'
import type { OwnerClient } from '@platform/core/database-testing'
import { DAY_MS, DsrStatus, DsrType, VerificationTokenType } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { StorageService } from '@platform/core/storage-module'

import { DsrPublicController } from '../../apps/api/src/modules/compliance/compliance.controller'
import { createCustomer } from '../builders'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { anonymousApi } from '../helpers/http'

const OK = 200
const BAD_REQUEST = 400

const ON: DsrConfig = {
  enabled: true,
  hashKey: 'h'.repeat(64),
  encryptionKeyHex: 'a'.repeat(64)
}

interface ErrorBody {
  error?: { code?: string; message?: string }
}

// The same answer for every refusal: the status, the code and the message. The body also carries the id of the request (`correlationId`), which
// differs on every call by design, so it is the one field left out of the comparison.
function expectSameAnswer(
  actual: { status: number; body: unknown },
  expected: { status: number; body: unknown }
): void {
  expect(actual.status).toBe(expected.status)
  const a = (actual.body as ErrorBody).error
  const b = (expected.body as ErrorBody).error
  expect(a?.code).toBe(ErrorCodes.DSR_EXPORT_LINK_INVALID)
  expect(a?.code).toBe(b?.code)
  expect(a?.message).toBeDefined()
  expect(a?.message).toBe(b?.message)
}

// Step 7.2-H2b-3: the PUBLIC download of the file of an access or portability request, through the real app and the real database, as the api
// runs. The person has no account, so every case is an anonymous call with a token: it must open the file of ITS request once, and every
// other token (used, expired, unknown, of another kind, of a request that is not a finished export) must get the one same answer.
describe('The public download of the file of a data request', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let storage: StorageService
  // The tokens point at a request by a plain text id (no foreign key), so the cleanup of the prefix does not reach them
  const requestIds: string[] = []

  beforeAll(async () => {
    owner = ownerClient()
    // The flow is off by default in the test environment; this suite is about what happens when it is on
    app = await createTestApp([], builder => builder.overrideProvider(DSR_CONFIG).useValue(ON))
    ctx = await seedTestContext(owner, app, prefix)
    storage = app.get(StorageService, { strict: false })
  })
  afterAll(async () => {
    await owner.verificationToken.deleteMany({ where: { subject: { in: requestIds } } })
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  // The bucket holds the file of every request this suite makes: the service looks for the object before it spends a token
  beforeEach(() => {
    jest.restoreAllMocks()
    jest.spyOn(storage, 'head').mockResolvedValue({ contentLength: 10 } as never)
  })

  const post = (token: unknown) =>
    anonymousApi(app).post(ApiRoutes.compliance.dsrExportDownload).send({ token })

  // A finished export of store A and the token its mail would carry (only the hash is in the database, as the sender writes it)
  async function finished(
    overrides: {
      type?: string
      status?: string
      key?: string | null
      expiresAt?: Date | null
      tokenType?: string
      tokenExpiresAt?: Date
      used?: boolean
      storeId?: string
      organizationId?: string
    } = {}
  ): Promise<{ id: string; token: string }> {
    const storeId = overrides.storeId ?? ctx.storeA.id
    const customer = await createCustomer(owner, { storeId })
    const email = `${prefix}-${randomUUID().slice(0, 6)}@example.com`
    await owner.customer.update({ where: { id: customer.id }, data: { email } })
    const { id } = await owner.dataSubjectRequest.create({
      data: {
        organizationId: overrides.organizationId ?? ctx.orgA.id,
        storeId,
        type: overrides.type ?? DsrType.ACCESS,
        status: overrides.status ?? DsrStatus.COMPLETED,
        subjectType: 'customer',
        subjectEmailHash: dsrEmailHash(email, ON.hashKey),
        subjectCustomerIds: [customer.id],
        notifyToEncrypted: encrypt(email, parseEncryptionKey(ON.encryptionKeyHex)),
        verifiedAt: new Date(),
        deadlineAt: new Date(Date.now() + 30 * DAY_MS),
        completedAt: new Date(),
        resultKey:
          overrides.key === undefined ? `compliance/dsr/${randomUUID()}.zip` : overrides.key,
        resultExpiresAt:
          overrides.expiresAt === undefined ? new Date(Date.now() + DAY_MS) : overrides.expiresAt
      },
      select: { id: true }
    })
    requestIds.push(id)
    const token = generateToken()
    await owner.verificationToken.create({
      data: {
        type: overrides.tokenType ?? VerificationTokenType.DSR_EXPORT_DOWNLOAD,
        tokenHash: hashToken(token),
        subject: id,
        expiresAt: overrides.tokenExpiresAt ?? new Date(Date.now() + DAY_MS),
        usedAt: overrides.used === true ? new Date() : null
      }
    })
    return { id, token }
  }

  it('trades the token for a short signed link to the file, once, and audits the request by its id', async () => {
    const { id, token } = await finished()

    const response = await post(token)

    expect(response.status).toBe(OK)
    const body = response.body as { url: string; filename: string; expiresInSeconds: number }
    expect(body.filename).toBe(ComplianceConfig.DSR_EXPORT_FILENAME)
    expect(body.expiresInSeconds).toBe(ComplianceConfig.DSR_EXPORT_DOWNLOAD_URL_SECONDS)
    expect(body.url).toContain('compliance/dsr/')
    // The response is never cached by a browser or a proxy
    expect(response.headers['cache-control']).toContain('no-store')
    const used = await owner.verificationToken.findFirstOrThrow({
      where: { tokenHash: hashToken(token) }
    })
    expect(used.usedAt).not.toBeNull()
    await waitForAuditEntries(owner, { action: AuditAction.DSR_EXPORT_DOWNLOADED, resourceId: id })
    const entry = await owner.auditLog.findFirstOrThrow({
      where: { action: AuditAction.DSR_EXPORT_DOWNLOADED, resourceId: id }
    })
    expect(JSON.stringify(entry)).not.toContain(token)
    expect(JSON.stringify(entry)).not.toContain('@example.com')
    expect(JSON.stringify(entry)).not.toContain('signature')
  })

  it('spends the other live links of the same request with the first download', async () => {
    const { id, token } = await finished()
    const second = generateToken()
    await owner.verificationToken.create({
      data: {
        type: VerificationTokenType.DSR_EXPORT_DOWNLOAD,
        tokenHash: hashToken(second),
        subject: id,
        expiresAt: new Date(Date.now() + DAY_MS)
      }
    })

    expect((await post(token)).status).toBe(OK)

    const other = await post(second)
    expect(other.status).toBe(BAD_REQUEST)
    expect((other.body as ErrorBody).error?.code).toBe(ErrorCodes.DSR_EXPORT_LINK_INVALID)
  })

  it('opens it for a portability request too', async () => {
    const { token } = await finished({ type: DsrType.PORTABILITY })
    expect((await post(token)).status).toBe(OK)
  })

  it('answers the same error to the second call of the same token, and to a token that never existed', async () => {
    const { token } = await finished()
    expect((await post(token)).status).toBe(OK)

    const again = await post(token)
    const unknown = await post(generateToken())

    expect(again.status).toBe(BAD_REQUEST)
    expect(unknown.status).toBe(BAD_REQUEST)
    expect((again.body as ErrorBody).error?.code).toBe(ErrorCodes.DSR_EXPORT_LINK_INVALID)
    expectSameAnswer(again, unknown)
  })

  it('lets exactly one of several calls at the same time through', async () => {
    const { token } = await finished()

    const answers = await Promise.all([post(token), post(token), post(token), post(token)])

    expect(answers.filter(answer => answer.status === OK)).toHaveLength(1)
    expect(answers.filter(answer => answer.status === BAD_REQUEST)).toHaveLength(3)
  })

  it.each([
    ['an expired token', () => finished({ tokenExpiresAt: new Date(Date.now() - 1000) }), false],
    ['a token already used', () => finished({ used: true }), true],
    [
      'the token of the verification mail',
      () => finished({ tokenType: VerificationTokenType.DSR_VERIFICATION }),
      false
    ],
    ['a request that is not completed', () => finished({ status: DsrStatus.IN_PROGRESS }), false],
    ['an erasure', () => finished({ type: DsrType.ERASURE }), false],
    ['a file that was purged', () => finished({ key: null }), false],
    ['a file past its date', () => finished({ expiresAt: new Date(Date.now() - 1000) }), false]
  ])(
    'answers the one same error for %s, signs nothing and spends nothing',
    async (_name, make, wasUsed) => {
      const unknown = await post(generateToken())
      const { id, token } = await make()

      const response = await post(token)

      expect(response.status).toBe(BAD_REQUEST)
      expectSameAnswer(response, unknown)
      expect(
        await owner.auditLog.count({
          where: { action: AuditAction.DSR_EXPORT_DOWNLOADED, resourceId: id }
        })
      ).toBe(0)
      const row = await owner.verificationToken.findFirstOrThrow({
        where: { tokenHash: hashToken(token) }
      })
      // A token that was already used keeps its date; every other one is left as it was
      expect(row.usedAt === null).toBe(!wasUsed)
    }
  )

  it('opens only the request its token names: the tokens of a sibling store and of another organization stay unspent', async () => {
    const mine = await finished()
    const sibling = await finished({ storeId: ctx.storeA2.id })
    const foreign = await finished({ storeId: ctx.storeB.id, organizationId: ctx.orgB.id })

    expect((await post(mine.token)).status).toBe(OK)
    await waitForAuditEntries(owner, {
      action: AuditAction.DSR_EXPORT_DOWNLOADED,
      resourceId: mine.id
    })

    for (const other of [sibling, foreign]) {
      const row = await owner.verificationToken.findFirstOrThrow({
        where: { tokenHash: hashToken(other.token) }
      })
      expect(row.usedAt).toBeNull()
      expect(
        await owner.auditLog.count({
          where: { action: AuditAction.DSR_EXPORT_DOWNLOADED, resourceId: other.id }
        })
      ).toBe(0)
    }
    // Each one then opens its own file
    expect((await post(sibling.token)).status).toBe(OK)
    expect((await post(foreign.token)).status).toBe(OK)
  })

  it('does not spend the token when the bucket no longer holds the file, and the person can try again', async () => {
    const { token } = await finished()
    const head = jest.spyOn(storage, 'head').mockResolvedValueOnce(null)

    const gone = await post(token)

    expect(gone.status).toBe(BAD_REQUEST)
    expect((gone.body as ErrorBody).error?.code).toBe(ErrorCodes.DSR_EXPORT_LINK_INVALID)
    const row = await owner.verificationToken.findFirstOrThrow({
      where: { tokenHash: hashToken(token) }
    })
    expect(row.usedAt).toBeNull()
    expect(head).toHaveBeenCalledTimes(1)
    expect((await post(token)).status).toBe(OK)
  })

  it('does not spend the token when the link cannot be signed', async () => {
    const { token } = await finished()
    jest.spyOn(storage, 'downloadUrl').mockRejectedValueOnce(new Error('signer down'))

    const failed = await post(token)

    expect(failed.status).toBeGreaterThanOrEqual(500)
    const row = await owner.verificationToken.findFirstOrThrow({
      where: { tokenHash: hashToken(token) }
    })
    expect(row.usedAt).toBeNull()
    expect((await post(token)).status).toBe(OK)
  })

  it.each([
    ['no token', undefined],
    ['an empty token', ''],
    ['a token of the wrong length', 'short'],
    ['an object', { $ne: null }]
  ])('refuses %s before looking anything up', async (_name, token) => {
    const response = await post(token)
    expect(response.status).toBe(BAD_REQUEST)
  })

  it('is rate limited per address with the profile of its own', () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- read for its decorator metadata, never called
    const handler = DsrPublicController.prototype.download
    const name = ThrottlerNames.DEFAULT
    expect(Reflect.getMetadata(`THROTTLER:LIMIT${name}`, handler)).toBe(
      DsrExportDownloadThrottle.limit
    )
    expect(Reflect.getMetadata(`THROTTLER:TTL${name}`, handler)).toBe(
      DsrExportDownloadThrottle.ttlMs
    )
  })

  it('takes the token from the body only: a token in the path or the query opens nothing', async () => {
    const { token } = await finished()
    const viaQuery = await anonymousApi(app).post(
      `${ApiRoutes.compliance.dsrExportDownload}?token=${token}`
    )
    const viaGet = await anonymousApi(app).get(
      `${ApiRoutes.compliance.dsrExportDownload}?token=${token}`
    )
    expect(viaQuery.status).toBe(BAD_REQUEST)
    expect(viaGet.status).not.toBe(OK)
    expect((await post(token)).status).toBe(OK)
  })
})
