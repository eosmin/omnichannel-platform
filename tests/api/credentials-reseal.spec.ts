import { randomBytes } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import type { PinoLogger } from 'nestjs-pino'

import { CredentialCipher } from '@platform/core/crypto'
import { JobContext } from '@platform/core/database'
import type { OwnerClient } from '@platform/core/database-testing'
import { invitationOutboxAad } from '@platform/core/email'

import {
  CredentialsResealService,
  type CredentialsResealUnit
} from '../../apps/worker/src/credentials/credentials-reseal.service'
import { createCarrierConnection } from '../builders/carrier-connection'
import { createChannelConnection } from '../builders/conversation'
import { createDataSubjectRequest } from '../builders/dsr'
import { ensurePluginInstallation } from '../builders/plugin'
import { createInvitation } from '../builders/team'
import { createWebhook } from '../builders/webhook'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { onWorkerDatabase, createGuardedWorkerPrisma } from '../helpers/worker-db'

// The re-seal of the sealed credentials outside the fiscal area after a rotation of CREDENTIALS_ENCRYPTION_KEY (Step 7.3-S11c), against the
// real database and as the ROLE OF THE WORKER (so its grants and the row security of every table are part of the proof). Keys are made on the
// fly. Proved: every sealed column of the closed list is sealed again and only the new key opens it, to the same content; a value that opens
// with neither key is left byte for byte as it was and does not stop the rest; a second run changes nothing; another organization is never
// touched; no audit entry or log carries a value.
describe('The re-seal of the sealed credentials after a rotation of the key', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  const oldKey = randomBytes(32)
  const newKey = randomBytes(32)
  const oldCipher = new CredentialCipher(oldKey)
  const newCipher = new CredentialCipher(newKey)
  const stranger = new CredentialCipher(randomBytes(32))
  const audited: unknown[] = []
  const logged: unknown[] = []
  const logger = {
    setContext: () => undefined,
    error: (entry: unknown) => logged.push(entry),
    info: () => undefined,
    warn: () => undefined
  } as unknown as PinoLogger
  const SECRET = 'reseal-secret-value-ZZZ'
  const ADDRESS = 'closing@reseal.example.com'

  const ids = {
    webhook: '',
    connection: '',
    carrier: '',
    installation: '',
    invitation: '',
    request: '',
    otherWebhook: ''
  }
  let invitationAad = ''

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp([], onWorkerDatabase())
    ctx = await seedTestContext(owner, app, prefix)
    const a = ctx.storeA.id
    ids.webhook = (await createWebhook(owner, { storeId: a })).id
    ids.otherWebhook = (await createWebhook(owner, { storeId: ctx.storeB.id })).id
    ids.connection = (
      await createChannelConnection(owner, { storeId: a, channelType: `${prefix}-chan` })
    ).id
    ids.carrier = (await createCarrierConnection(owner, { storeId: a })).id
    ids.installation = (
      await ensurePluginInstallation(owner, { storeId: a, pluginId: `${prefix}-chan` })
    ).id
    ids.invitation = (await createInvitation(owner, { storeId: a, prefix })).id
    ids.request = (await createDataSubjectRequest(owner, { storeId: a })).id
    invitationAad = invitationOutboxAad(a, ids.invitation)
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  // Seals every column of the list with the OLD key (the state after the owner set the new key and the old one as previous)
  async function sealAllWithOldKey(): Promise<void> {
    const bytes = (b: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(b)
    await owner.webhook.update({
      where: { id: ids.webhook },
      data: { secret: bytes(oldCipher.seal({ secret: SECRET })) }
    })
    await owner.channelConnection.update({
      where: { id: ids.connection },
      data: { credentials: bytes(oldCipher.seal({ token: SECRET })) }
    })
    await owner.carrierConnection.update({
      where: { id: ids.carrier },
      data: {
        // The courier of the store has no credentials; a connection that has them is of a carrier that is called
        carrierId: `${prefix}-carrier`,
        credentials: bytes(oldCipher.seal({ apiKey: SECRET })),
        webhookSecret: bytes(oldCipher.seal({ secret: SECRET }))
      }
    })
    await owner.pluginInstallation.update({
      where: { id: ids.installation },
      data: {
        webhookSecret: bytes(oldCipher.seal({ secret: SECRET })),
        commandSecret: bytes(oldCipher.seal({ secret: SECRET })),
        commandSecretPrevious: bytes(oldCipher.seal({ secret: SECRET }))
      }
    })
    await owner.invitation.update({
      where: { id: ids.invitation },
      data: { emailOutbox: bytes(oldCipher.seal({ template: 't', to: ADDRESS }, invitationAad)) }
    })
    await owner.dataSubjectRequest.update({
      where: { id: ids.request },
      data: { notifyToEncrypted: bytes(oldCipher.sealText(ADDRESS)) }
    })
  }

  const prisma = (): ReturnType<typeof createGuardedWorkerPrisma> => createGuardedWorkerPrisma()
  const unitOf =
    (organizationId: string): CredentialsResealUnit =>
    work =>
      new JobContext(prisma()).inOrganization(organizationId, work)
  const service = (cipher: CredentialCipher): CredentialsResealService =>
    new CredentialsResealService(
      prisma(),
      cipher,
      { log: (entry: unknown) => audited.push(entry) } as never,
      logger
    )
  const rotated = (): CredentialCipher => new CredentialCipher(newKey, oldKey)

  async function columns(): Promise<Record<string, Uint8Array | null>> {
    const [webhook, connection, carrier, installation, invitation, request] = await Promise.all([
      owner.webhook.findUniqueOrThrow({ where: { id: ids.webhook } }),
      owner.channelConnection.findUniqueOrThrow({ where: { id: ids.connection } }),
      owner.carrierConnection.findUniqueOrThrow({ where: { id: ids.carrier } }),
      owner.pluginInstallation.findUniqueOrThrow({ where: { id: ids.installation } }),
      owner.invitation.findUniqueOrThrow({ where: { id: ids.invitation } }),
      owner.dataSubjectRequest.findUniqueOrThrow({ where: { id: ids.request } })
    ])
    return {
      webhook: webhook.secret,
      connection: connection.credentials,
      carrier: carrier.credentials,
      carrierWebhook: carrier.webhookSecret,
      pluginWebhook: installation.webhookSecret,
      command: installation.commandSecret,
      commandPrevious: installation.commandSecretPrevious,
      invitation: invitation.emailOutbox,
      request: request.notifyToEncrypted
    }
  }

  beforeEach(() => {
    audited.length = 0
    logged.length = 0
  })

  it('seals again every sealed column of the list, opens only with the new key to the same content, audits without a value, and a second run changes nothing', async () => {
    await sealAllWithOldKey()

    const report = await service(rotated()).run(ctx.orgA.id, unitOf(ctx.orgA.id))

    expect(report).toMatchObject({ enabled: true, failed: {}, truncated: false })
    expect(report.resealed).toBeGreaterThanOrEqual(9)
    const rows = await columns()
    const json = (k: string, aad?: string): unknown => newCipher.open(rows[k] as Uint8Array, aad)
    expect(json('webhook')).toEqual({ secret: SECRET })
    expect(json('connection')).toEqual({ token: SECRET })
    expect(json('carrier')).toEqual({ apiKey: SECRET })
    expect(json('carrierWebhook')).toEqual({ secret: SECRET })
    expect(json('pluginWebhook')).toEqual({ secret: SECRET })
    expect(json('command')).toEqual({ secret: SECRET })
    expect(json('commandPrevious')).toEqual({ secret: SECRET })
    expect(json('invitation', invitationAad)).toEqual({ template: 't', to: ADDRESS })
    expect(newCipher.openText(rows['request'] as Uint8Array)).toBe(ADDRESS)
    // The old key alone no longer opens any of them
    expect(() => oldCipher.open(rows['webhook'] as Uint8Array)).toThrow()
    // One audit entry per value, naming the column and the row, never a value
    expect(audited.length).toBe(report.resealed)
    expect(JSON.stringify(audited)).not.toContain(SECRET)
    expect(JSON.stringify(audited)).not.toContain(ADDRESS)
    expect(JSON.stringify(logged)).not.toContain(SECRET)

    audited.length = 0
    const again = await service(rotated()).run(ctx.orgA.id, unitOf(ctx.orgA.id))
    expect(again).toMatchObject({ resealed: 0, conflicts: 0, failed: {} })
    expect(again.current).toBeGreaterThanOrEqual(9)
    expect(audited).toEqual([])
    const after = await columns()
    for (const [k, v] of Object.entries(rows)) {
      expect(Buffer.from(after[k] as Uint8Array).equals(Buffer.from(v as Uint8Array))).toBe(true)
    }
  })

  it('leaves a value that opens with neither key byte for byte as it was, counts it by code, and still seals the rest', async () => {
    await sealAllWithOldKey()
    const foreign = new Uint8Array(stranger.seal({ secret: SECRET }))
    await owner.webhook.update({ where: { id: ids.webhook }, data: { secret: foreign } })
    // A value that is not even shaped like a sealed one
    const damaged = Buffer.from('not-a-sealed-secret')
    await owner.carrierConnection.update({
      where: { id: ids.carrier },
      data: { webhookSecret: new Uint8Array(damaged) }
    })

    const report = await service(rotated()).run(ctx.orgA.id, unitOf(ctx.orgA.id))

    expect(report.failed).toEqual({ key_mismatch: 1, row_damaged: 1 })
    const rows = await columns()
    expect(Buffer.from(rows['webhook'] as Uint8Array).equals(Buffer.from(foreign))).toBe(true)
    expect(Buffer.from(rows['carrierWebhook'] as Uint8Array).equals(damaged)).toBe(true)
    // The others were sealed again in the same run
    expect(newCipher.open(rows['connection'] as Uint8Array)).toEqual({ token: SECRET })
    expect(newCipher.openText(rows['request'] as Uint8Array)).toBe(ADDRESS)
    // The log names the column and the row, never the value
    expect(JSON.stringify(logged)).not.toContain(SECRET)
    expect(logged).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ failure: 'key_mismatch', what: 'webhook-secret' })
      ])
    )
  })

  it('never touches another organization and never reads anything without a previous key', async () => {
    await sealAllWithOldKey()
    const before = (await owner.webhook.findUniqueOrThrow({ where: { id: ids.otherWebhook } }))
      .secret
    await owner.webhook.update({
      where: { id: ids.otherWebhook },
      data: { secret: new Uint8Array(oldCipher.seal({ secret: SECRET })) }
    })
    const sealedOther = (await owner.webhook.findUniqueOrThrow({ where: { id: ids.otherWebhook } }))
      .secret

    await service(rotated()).run(ctx.orgA.id, unitOf(ctx.orgA.id))

    const otherAfter = (await owner.webhook.findUniqueOrThrow({ where: { id: ids.otherWebhook } }))
      .secret
    expect(Buffer.from(otherAfter).equals(Buffer.from(sealedOther))).toBe(true)
    expect(before).not.toBeNull()

    const idle = await service(new CredentialCipher(newKey)).run(ctx.orgA.id, unitOf(ctx.orgA.id))
    expect(idle).toMatchObject({ enabled: false, scanned: 0 })
  })
})
