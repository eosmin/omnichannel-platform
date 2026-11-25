import { randomBytes } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import type { PinoLogger } from 'nestjs-pino'

import { dsrExportPasswordAad } from '@platform/core/compliance'
import { CredentialCipher, DecryptionFailure } from '@platform/core/crypto'
import { JobContext } from '@platform/core/database'
import type { OwnerClient } from '@platform/core/database-testing'
import { SealedTargetIds } from '@platform/core/domain'
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
  const ZIP_PASSWORD = 'zip-password-of-a-data-export-0123456789'

  const ids = {
    webhook: '',
    connection: '',
    carrier: '',
    installation: '',
    invitation: '',
    request: '',
    otherWebhook: '',
    otherConnection: '',
    otherCarrier: '',
    otherInstallation: '',
    otherInvitation: '',
    otherRequest: ''
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
    const b = ctx.storeB.id
    ids.otherConnection = (
      await createChannelConnection(owner, { storeId: b, channelType: `${prefix}-chan-b` })
    ).id
    ids.otherCarrier = (await createCarrierConnection(owner, { storeId: b })).id
    ids.otherInstallation = (
      await ensurePluginInstallation(owner, { storeId: b, pluginId: `${prefix}-chan-b` })
    ).id
    ids.otherInvitation = (await createInvitation(owner, { storeId: b, prefix: `${prefix}b` })).id
    ids.otherRequest = (await createDataSubjectRequest(owner, { storeId: b })).id
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
      data: {
        notifyToEncrypted: bytes(oldCipher.sealText(ADDRESS)),
        resultPasswordSealed: bytes(
          oldCipher.sealText(ZIP_PASSWORD, dsrExportPasswordAad(ids.request))
        )
      }
    })
  }

  // The same nine columns in the OTHER organization, sealed with the old key: a run for the first one must never touch them
  async function sealOtherOrganizationWithOldKey(): Promise<Record<string, Uint8Array | null>> {
    const bytes = (b: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(b)
    const sealed = (): Uint8Array<ArrayBuffer> => bytes(oldCipher.seal({ secret: SECRET }))
    await owner.webhook.update({ where: { id: ids.otherWebhook }, data: { secret: sealed() } })
    await owner.channelConnection.update({
      where: { id: ids.otherConnection },
      data: { credentials: sealed() }
    })
    await owner.carrierConnection.update({
      where: { id: ids.otherCarrier },
      data: {
        carrierId: `${prefix}-carrier-b`,
        credentials: sealed(),
        webhookSecret: sealed()
      }
    })
    await owner.pluginInstallation.update({
      where: { id: ids.otherInstallation },
      data: { webhookSecret: sealed(), commandSecret: sealed(), commandSecretPrevious: sealed() }
    })
    await owner.invitation.update({
      where: { id: ids.otherInvitation },
      data: { emailOutbox: bytes(oldCipher.seal({ to: ADDRESS })) }
    })
    await owner.dataSubjectRequest.update({
      where: { id: ids.otherRequest },
      data: {
        notifyToEncrypted: bytes(oldCipher.sealText(ADDRESS)),
        resultPasswordSealed: bytes(
          oldCipher.sealText(ZIP_PASSWORD, dsrExportPasswordAad(ids.otherRequest))
        )
      }
    })
    return otherColumns()
  }
  async function otherColumns(): Promise<Record<string, Uint8Array | null>> {
    const [webhook, connection, carrier, installation, invitation, request] = await Promise.all([
      owner.webhook.findUniqueOrThrow({ where: { id: ids.otherWebhook } }),
      owner.channelConnection.findUniqueOrThrow({ where: { id: ids.otherConnection } }),
      owner.carrierConnection.findUniqueOrThrow({ where: { id: ids.otherCarrier } }),
      owner.pluginInstallation.findUniqueOrThrow({ where: { id: ids.otherInstallation } }),
      owner.invitation.findUniqueOrThrow({ where: { id: ids.otherInvitation } }),
      owner.dataSubjectRequest.findUniqueOrThrow({ where: { id: ids.otherRequest } })
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
      request: request.notifyToEncrypted,
      exportPassword: request.resultPasswordSealed
    }
  }
  const sameBytes = (a: Uint8Array | null, b: Uint8Array | null): boolean =>
    a !== null && b !== null && Buffer.from(a).equals(Buffer.from(b))

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
      request: request.notifyToEncrypted,
      exportPassword: request.resultPasswordSealed
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
    expect(report.resealed).toBeGreaterThanOrEqual(10)
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
    expect(
      newCipher.openText(rows['exportPassword'] as Uint8Array, dsrExportPasswordAad(ids.request))
    ).toBe(ZIP_PASSWORD)
    // The old key alone no longer opens any of them
    expect(() => oldCipher.open(rows['webhook'] as Uint8Array)).toThrow()
    // One audit entry per value, naming the column and the row, never a value
    expect(audited.length).toBe(report.resealed)
    expect(JSON.stringify(audited)).not.toContain(SECRET)
    expect(JSON.stringify(audited)).not.toContain(ADDRESS)
    expect(JSON.stringify(audited)).not.toContain(ZIP_PASSWORD)
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

    expect(report.failed).toEqual({
      [DecryptionFailure.KEY_MISMATCH]: 1,
      [DecryptionFailure.ROW_DAMAGED]: 1
    })
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
        expect.objectContaining({
          failure: DecryptionFailure.KEY_MISMATCH,
          what: SealedTargetIds.WEBHOOK_SECRET
        })
      ])
    )
  })

  it('never touches another organization (all nine columns) and never reads anything without a previous key', async () => {
    await sealAllWithOldKey()
    const other = await sealOtherOrganizationWithOldKey()

    await service(rotated()).run(ctx.orgA.id, unitOf(ctx.orgA.id))

    const after = await otherColumns()
    for (const [k, v] of Object.entries(other)) expect(sameBytes(after[k] ?? null, v)).toBe(true)

    const idle = await service(new CredentialCipher(newKey)).run(ctx.orgA.id, unitOf(ctx.orgA.id))
    expect(idle).toMatchObject({ enabled: false, scanned: 0 })
  })

  it('seals again an outbox written before the binding (format 1, no data), and the result opens only bound to its row', async () => {
    await sealAllWithOldKey()
    // Format 1: sealed without the data of the row. It opens even when the data is given: measured here, not assumed
    const legacy = oldCipher.seal({ template: 't', to: ADDRESS })
    expect(legacy[0]).toBe(1)
    expect(oldCipher.open(legacy, invitationAad)).toEqual({ template: 't', to: ADDRESS })
    await owner.invitation.update({
      where: { id: ids.invitation },
      data: { emailOutbox: new Uint8Array(legacy) }
    })

    const report = await service(rotated()).run(ctx.orgA.id, unitOf(ctx.orgA.id))

    expect(report.failed).toEqual({})
    const row = await owner.invitation.findUniqueOrThrow({ where: { id: ids.invitation } })
    const sealedNow = row.emailOutbox as Uint8Array
    // Sealed again bound (format 2): it needs its own data now, and the current key alone
    expect(sealedNow[0]).toBe(2)
    expect(newCipher.open(sealedNow, invitationAad)).toEqual({ template: 't', to: ADDRESS })
    expect(() => newCipher.open(sealedNow)).toThrow()
  })

  it('a row that changes between the read and the swap is a conflict, the change is kept, and the next run picks the row up', async () => {
    await sealAllWithOldKey()
    const changed = new Uint8Array(oldCipher.seal({ token: 'changed-by-a-person' }))
    let calls = 0
    // The second unit is the swap of the first value (the credentials of the connection): somebody saves the row just before it
    const racing: CredentialsResealUnit = async work => {
      calls += 1
      if (calls === 2) {
        await owner.channelConnection.update({
          where: { id: ids.connection },
          data: { credentials: changed }
        })
      }
      return unitOf(ctx.orgA.id)(work)
    }

    const report = await service(rotated()).run(ctx.orgA.id, racing)

    expect(report.conflicts).toBe(1)
    const row = await owner.channelConnection.findUniqueOrThrow({ where: { id: ids.connection } })
    expect(sameBytes(row.credentials, changed)).toBe(true)
    const next = await service(rotated()).run(ctx.orgA.id, unitOf(ctx.orgA.id))
    expect(next.conflicts).toBe(0)
    const after = await owner.channelConnection.findUniqueOrThrow({ where: { id: ids.connection } })
    expect(newCipher.open(after.credentials)).toEqual({ token: 'changed-by-a-person' })
  })

  it('worst case: a WRONG previous key writes nothing, counts every value by code, and does not stop another organization', async () => {
    await sealAllWithOldKey()
    await sealOtherOrganizationWithOldKey()
    const before = await columns()
    const wrongPrevious = new CredentialCipher(newKey, randomBytes(32))

    const report = await service(wrongPrevious).run(ctx.orgA.id, unitOf(ctx.orgA.id))

    // Nothing was sealed again, every value is counted as a key mismatch, and no entry of the audit names a success
    expect(report.resealed).toBe(0)
    expect(report.failed[DecryptionFailure.KEY_MISMATCH]).toBeGreaterThanOrEqual(9)
    expect(Object.keys(report.failed)).toEqual([DecryptionFailure.KEY_MISMATCH])
    expect(audited).toEqual([])
    const after = await columns()
    for (const [k, v] of Object.entries(before)) {
      expect(Buffer.from(after[k] as Uint8Array).equals(Buffer.from(v as Uint8Array))).toBe(true)
    }
    // The failure of one organization is its own: another one, run next with the right keys, is sealed again
    const other = await service(rotated()).run(ctx.orgB.id, unitOf(ctx.orgB.id))
    expect(other).toMatchObject({ failed: {} })
    expect(other.resealed).toBeGreaterThanOrEqual(1)
    const otherRow = await owner.webhook.findUniqueOrThrow({ where: { id: ids.otherWebhook } })
    expect(newCipher.open(otherRow.secret)).toEqual({ secret: SECRET })
    // The values of the first organization are still there for the next night with the right key
    const retry = await service(rotated()).run(ctx.orgA.id, unitOf(ctx.orgA.id))
    expect(retry.failed).toEqual({})
    expect(retry.resealed).toBeGreaterThanOrEqual(9)
  })
})
