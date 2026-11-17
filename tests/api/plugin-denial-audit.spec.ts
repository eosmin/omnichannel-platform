import { randomBytes, randomInt } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import { Redis } from 'ioredis'
import supertest from 'supertest'

import { API_PREFIX, PluginApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { CacheKeys } from '@platform/core/cache'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  PLUGIN_API_KEY_TOKEN_PREFIX,
  PluginApiDenialAudit,
  PluginApiDenialReasons,
  PluginInstallationStatus
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { PluginScopes } from '@platform/plugins/sdk'

import { REDIS_URL } from '../../apps/api/src/testing/test-env'
import { createPluginKey } from '../builders'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'

const OK = 200
const UNAUTHORIZED = 401
const FORBIDDEN = 403
const FLOOD = 25
// More unknown keys, from more addresses, than the whole window takes
const UNKNOWN_FLOOD = PluginApiDenialAudit.ANONYMOUS_PER_WINDOW + 40

interface ErrorBody {
  error: { code: string }
}

// PLG-198: the refusals of the guard of the plugin API leave an audit entry (the platform as the actor, the installation and the
// reason on the metadata, never the key), and a plugin that keeps probing cannot fill the table
describe('the audit of the calls the plugin API refuses', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let reader: { key: string; installationId: string }
  let revoked: { key: string; installationId: string }

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    reader = await createPluginKey(owner, {
      storeId: ctx.storeA.id,
      pluginId: `${prefix}-reader`,
      scopes: [PluginScopes.TAGS_READ]
    })
    revoked = await createPluginKey(owner, {
      storeId: ctx.storeA.id,
      pluginId: `${prefix}-revoked`,
      scopes: [PluginScopes.CUSTOMERS_READ]
    })
    await owner.pluginInstallation.update({
      where: { id: revoked.installationId },
      data: { status: PluginInstallationStatus.REVOKED, revokedAt: new Date() }
    })
  })
  afterAll(async () => {
    await owner.pluginInstallation.deleteMany({ where: { pluginId: { startsWith: prefix } } })
    await owner.plugin.deleteMany({ where: { id: { startsWith: prefix } } })
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const get = (path: string, key: string) => {
    const server = app.getHttpServer() as Parameters<typeof supertest>[0]
    return supertest(server)
      .get(`${API_PREFIX}${path}`)
      .set('x-forwarded-for', `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`)
      .set('authorization', `Bearer ${key}`)
  }
  const entriesOf = (installationId: string) =>
    waitForAuditEntries(
      owner,
      { action: AuditAction.PLUGIN_API_DENIED, resourceId: installationId },
      1
    )
  const settle = () => new Promise(resolve => setTimeout(resolve, 600))

  it('audits a scope the key lacks: the platform acts, the installation and the reason are on the entry, no key', async () => {
    const answer = await get(PluginApiRoutes.customers.list, reader.key)
    expect(answer.status).toBe(FORBIDDEN)
    expect((answer.body as ErrorBody).error.code).toBe(ErrorCodes.PLUGIN_SCOPE_DENIED)

    const [entry] = await entriesOf(reader.installationId)
    expect(entry).toMatchObject({
      action: AuditAction.PLUGIN_API_DENIED,
      userId: null,
      storeId: ctx.storeA.id,
      resourceType: 'plugin_installation',
      resourceId: reader.installationId
    })
    expect(entry?.metadata).toMatchObject({
      pluginId: `${prefix}-reader`,
      installationId: reader.installationId,
      reason: PluginApiDenialReasons.SCOPE,
      method: 'GET',
      missing: [PluginScopes.CUSTOMERS_READ]
    })
    const text = JSON.stringify(entry)
    expect(text).not.toContain(reader.key)
    expect(text).not.toContain(reader.key.slice(PLUGIN_API_KEY_TOKEN_PREFIX.length))
  })

  it('writes one entry per installation and reason in a window, however many refusals come', async () => {
    await Promise.all(
      Array.from({ length: FLOOD }, () => get(PluginApiRoutes.customers.list, reader.key))
    )
    await settle()
    const rows = await owner.auditLog.count({
      where: { action: AuditAction.PLUGIN_API_DENIED, resourceId: reader.installationId }
    })
    expect(rows).toBe(1)
  })

  it('audits a key whose installation is revoked, as a reason of its own, without telling the caller', async () => {
    const answer = await get(PluginApiRoutes.customers.list, revoked.key)
    expect(answer.status).toBe(UNAUTHORIZED)
    expect((answer.body as ErrorBody).error.code).toBe(ErrorCodes.PLUGIN_API_KEY_INVALID)

    const [entry] = await entriesOf(revoked.installationId)
    expect(entry?.metadata).toMatchObject({
      installationId: revoked.installationId,
      reason: PluginApiDenialReasons.INACTIVE,
      installationStatus: PluginInstallationStatus.REVOKED
    })
    expect(JSON.stringify(entry)).not.toContain(revoked.key)
  })

  it('audits a key nobody knows with no installation and no key material, within a small budget for the window', async () => {
    // The budget of the window is shared with every other suite that sends a bad key: start it from zero
    const redis = new Redis(REDIS_URL)
    await redis.del(CacheKeys.audit.pluginDenialAnonymous)
    await redis.quit()
    const before = await owner.auditLog.count({
      where: { action: AuditAction.PLUGIN_API_DENIED, storeId: null }
    })
    const unknown = `${PLUGIN_API_KEY_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
    await Promise.all(
      Array.from({ length: UNKNOWN_FLOOD }, () => get(PluginApiRoutes.customers.list, unknown))
    )
    await settle()
    const rows = await owner.auditLog.findMany({
      where: { action: AuditAction.PLUGIN_API_DENIED, storeId: null },
      orderBy: { timestamp: 'asc' }
    })
    const added = rows.length - before
    expect(added).toBeGreaterThan(0)
    expect(added).toBeLessThanOrEqual(PluginApiDenialAudit.ANONYMOUS_PER_WINDOW)
    expect(added).toBeLessThan(UNKNOWN_FLOOD)
    const last = rows.at(-1)
    expect(last?.userId).toBeNull()
    expect(last?.metadata).toMatchObject({ reason: PluginApiDenialReasons.INVALID_KEY })
    expect(JSON.stringify(rows)).not.toContain(unknown.slice(PLUGIN_API_KEY_TOKEN_PREFIX.length))
  })

  it('writes no entry for a call that is allowed', async () => {
    const before = await owner.auditLog.count({
      where: { action: AuditAction.PLUGIN_API_DENIED, resourceId: reader.installationId }
    })
    const answer = await get(PluginApiRoutes.settings.tags, reader.key)
    expect(answer.status).toBe(OK)
    await settle()
    const after = await owner.auditLog.count({
      where: { action: AuditAction.PLUGIN_API_DENIED, resourceId: reader.installationId }
    })
    expect(after).toBe(before)
  })
})
