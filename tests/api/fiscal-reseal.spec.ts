import { randomBytes, randomInt, randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import type { PinoLogger } from 'nestjs-pino'
import pg from 'pg'

import { CredentialCipher } from '@platform/core/crypto'
import { JobContext, PrismaService } from '@platform/core/database'
import { connectionUrls, type OwnerClient } from '@platform/core/database-testing'
import { FiscalReseal } from '@platform/core/domain'
import { FiscalResealService, type FiscalResealUnit } from '@platform/fiscal/runtime'

import { createCustomer, createOrder } from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { onWorkerDatabase } from '../helpers/worker-db'

// The re-seal of the fiscal values after a rotation of CREDENTIALS_ENCRYPTION_KEY (Step 7.3-S11b-1). Keys are made on the fly (never a real
// one, never one in the repo). What is proved: a value sealed with the old key is sealed again with the new one, a decided document too and
// only through the function the guard recognises; a value that opens with neither key is left byte for byte as it was and does not stop the
// rest; a second run changes nothing; no role of the application can open the door of the guard by setting its name.
describe('The re-seal of the fiscal values after a rotation of the key', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  const oldKey = randomBytes(32)
  const newKey = randomBytes(32)
  const strangerKey = randomBytes(32)
  const oldCipher = new CredentialCipher(oldKey)
  const newCipher = new CredentialCipher(newKey)
  const stranger = new CredentialCipher(strangerKey)
  const audited: unknown[] = []
  const logger = {
    setContext: () => undefined,
    error: () => undefined,
    info: () => undefined,
    warn: () => undefined
  } as unknown as PinoLogger
  const raw = new pg.Client({ connectionString: connectionUrls().owner })

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp([], onWorkerDatabase())
    ctx = await seedTestContext(owner, app, prefix)
    await raw.connect()
    await owner.fiscalIssuer.upsert({
      where: { organizationId: ctx.orgA.id },
      create: {
        organizationId: ctx.orgA.id,
        providerId: 'simulator',
        legalName: 'reseal-issuer',
        taxId: 'RESEAL-TAX',
        address: { line1: 'x' },
        environment: 'sandbox'
      },
      update: {}
    })
  })
  afterAll(async () => {
    await raw.end().catch(() => undefined)
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const unit: FiscalResealUnit = work => app.get(JobContext).inOrganization(ctx.orgA.id, work)
  const service = (cipher: CredentialCipher): FiscalResealService =>
    new FiscalResealService(
      app.get(PrismaService),
      cipher,
      { log: (entry: unknown) => audited.push(entry) } as never,
      logger
    )
  const rotated = (): CredentialCipher => new CredentialCipher(newKey, oldKey)

  async function makeDocument(
    status: string,
    sealer: CredentialCipher,
    content: Record<string, unknown>
  ): Promise<string> {
    const order = await createOrder(owner, { storeId: ctx.storeA.id })
    const row = await owner.fiscalDocument.create({
      data: {
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        orderId: order.id,
        sequenceNumber: randomInt(1_000_000, 2_000_000_000),
        documentType: 'pending',
        status,
        providerId: 'simulator',
        environment: 'sandbox',
        issuerSnapshot: {},
        linesSnapshot: { lines: [] },
        receiverEncrypted: new Uint8Array(sealer.seal({ taxId: content['taxId'] ?? 'T-1' })),
        builtPayloadEncrypted: new Uint8Array(sealer.seal({ payload: content })),
        totalCents: 1999,
        taxCents: 0,
        // What the table asks of a voided document
        ...(status === 'voided'
          ? { voidReason: 'reseal fixture', voidedBy: randomUUID(), voidedAt: new Date() }
          : {})
      },
      select: { id: true }
    })
    return row.id
  }

  it('seals again a live, an accepted and a voided document, the customer data and the issuer credentials, and only the new key opens them', async () => {
    const live = await makeDocument('queued', oldCipher, { taxId: 'LIVE-TAX' })
    const accepted = await makeDocument('accepted', oldCipher, { taxId: 'ACCEPTED-TAX' })
    const voided = await makeDocument('voided', oldCipher, { taxId: 'VOIDED-TAX' })
    const customer = await createCustomer(owner, { storeId: ctx.storeA.id })
    await owner.customerFiscalData.create({
      data: {
        storeId: ctx.storeA.id,
        customerId: customer.id,
        dataEncrypted: new Uint8Array(oldCipher.seal({ taxId: 'CUSTOMER-TAX' }))
      }
    })
    await owner.fiscalIssuer.update({
      where: { organizationId: ctx.orgA.id },
      data: {
        credentialsEncrypted: new Uint8Array(oldCipher.seal({ signingKey: 'fake-signing-key' }))
      }
    })
    const contingency = await owner.fiscalContingency.create({
      data: {
        organizationId: ctx.orgA.id,
        providerId: 'simulator',
        environment: 'sandbox',
        status: 'closed',
        origin: 'user',
        reason: 'reseal fixture',
        eventCode: randomUUID(),
        startedAt: new Date(),
        endedAt: new Date(),
        responsibleEncrypted: new Uint8Array(oldCipher.seal({ name: 'RESPONSIBLE-NAME' }))
      },
      select: { id: true }
    })
    audited.length = 0

    const report = await service(rotated()).run(ctx.orgA.id, unit)

    expect(report).toMatchObject({ enabled: true, failed: {}, conflicts: 0, truncated: false })
    // three documents, one customer, one issuer, one contingency
    expect(report.resealed).toBe(6)
    for (const id of [live, accepted, voided]) {
      const row = await owner.fiscalDocument.findUniqueOrThrow({ where: { id } })
      expect(newCipher.open(row.receiverEncrypted)).toBeDefined()
      expect(newCipher.open(row.builtPayloadEncrypted ?? new Uint8Array())).toBeDefined()
      expect(() => oldCipher.open(row.receiverEncrypted)).toThrow()
      expect(row.status).toBe(id === live ? 'queued' : id === accepted ? 'accepted' : 'voided')
    }
    const customerRow = await owner.customerFiscalData.findUniqueOrThrow({
      where: { customerId: customer.id }
    })
    expect(newCipher.open(customerRow.dataEncrypted)).toEqual({ taxId: 'CUSTOMER-TAX' })
    const issuer = await owner.fiscalIssuer.findUniqueOrThrow({
      where: { organizationId: ctx.orgA.id }
    })
    expect(newCipher.open(issuer.credentialsEncrypted ?? new Uint8Array())).toEqual({
      signingKey: 'fake-signing-key'
    })
    const closed = await owner.fiscalContingency.findUniqueOrThrow({
      where: { id: contingency.id }
    })
    expect(newCipher.open(closed.responsibleEncrypted ?? new Uint8Array())).toEqual({
      name: 'RESPONSIBLE-NAME'
    })
    // One entry per value, with the kind and the row, and nothing of the content
    expect(audited).toHaveLength(6)
    expect(JSON.stringify(audited)).not.toMatch(/TAX|fake-signing-key|RESPONSIBLE/)

    // Idempotent: the second run finds every value current and writes nothing
    const again = await service(rotated()).run(ctx.orgA.id, unit)
    expect(again).toMatchObject({ resealed: 0, failed: {}, conflicts: 0 })
    expect(again.current).toBe(6)
  })

  it('leaves a value that opens with neither key byte for byte as it was, counts it and goes on with the rest', async () => {
    const lost = await makeDocument('accepted', stranger, { taxId: 'LOST-TAX' })
    const fine = await makeDocument('accepted', oldCipher, { taxId: 'FINE-TAX' })
    const before = await owner.fiscalDocument.findUniqueOrThrow({ where: { id: lost } })

    const report = await service(rotated()).run(ctx.orgA.id, unit)

    expect(report.failed).toEqual({ key_mismatch: 1 })
    expect(report.resealed).toBe(1)
    const after = await owner.fiscalDocument.findUniqueOrThrow({ where: { id: lost } })
    expect(Buffer.from(after.receiverEncrypted).equals(Buffer.from(before.receiverEncrypted))).toBe(
      true
    )
    expect(
      Buffer.from(after.builtPayloadEncrypted ?? []).equals(
        Buffer.from(before.builtPayloadEncrypted ?? [])
      )
    ).toBe(true)
    expect(
      newCipher.open(
        (await owner.fiscalDocument.findUniqueOrThrow({ where: { id: fine } })).receiverEncrypted
      )
    ).toEqual({ taxId: 'FINE-TAX' })
  })

  it('does nothing and reads nothing when no previous key is held', async () => {
    const report = await service(newCipher).run(ctx.orgA.id, unit)
    expect(report).toMatchObject({ enabled: false, scanned: 0, resealed: 0 })
  })

  describe('the guard of a decided document', () => {
    let documentId: string
    beforeAll(async () => {
      documentId = await makeDocument('accepted', newCipher, { taxId: 'GUARD-TAX' })
    })

    // The role is taken on the owner's connection like the other suites of row security do; the context lets the row be seen, so a refusal
    // is the guard's and not the policy's
    async function asRole<T>(role: string, work: () => Promise<T>): Promise<T> {
      await raw.query('BEGIN')
      try {
        await raw.query(`SET LOCAL ROLE ${role}`)
        await raw.query(
          "SELECT set_config('app.organization_ids', $1, true), set_config('app.store_ids', $2, true)",
          [ctx.orgA.id, ctx.storeA.id]
        )
        return await work()
      } finally {
        await raw.query('ROLLBACK').catch(() => undefined)
      }
    }
    const swapSql = `UPDATE fiscal_documents SET receiver_encrypted = $2::bytea WHERE id = $1`

    it.each(['platform_app', 'platform_worker'])(
      'is not opened by the setting alone for %s: the swap is still refused',
      async role => {
        await expect(
          asRole(role, async () => {
            await raw.query(`SELECT set_config('${FiscalReseal.SETTING}', 'on', true)`)
            await raw.query(swapSql, [documentId, Buffer.from('forged')])
          })
        ).rejects.toMatchObject({ message: expect.stringContaining('immutable') as string })
      }
    )

    it('is not reached by the application role through the function: only the worker may call it', async () => {
      await expect(
        asRole('platform_app', () =>
          raw.query(
            `SELECT ${FiscalReseal.FUNCTION}($1, $2, $3::bytea, $4::bytea, NULL::bytea, NULL::bytea)`,
            [ctx.orgA.id, documentId, Buffer.from('a'), Buffer.from('b')]
          )
        )
      ).rejects.toMatchObject({ code: '42501' })
    })

    it('refuses the function for an organization that is not in the context of the worker', async () => {
      await expect(
        asRole('platform_worker', () =>
          raw.query(
            `SELECT ${FiscalReseal.FUNCTION}($1, $2, $3::bytea, $4::bytea, NULL::bytea, NULL::bytea)`,
            [ctx.orgB.id, documentId, Buffer.from('a'), Buffer.from('b')]
          )
        )
      ).rejects.toMatchObject({ code: '42501' })
    })

    it('swaps nothing when the old bytes are not the ones in the row (compare-and-swap)', async () => {
      const answer = await asRole('platform_worker', () =>
        raw.query<{ changed: boolean }>(
          `SELECT ${FiscalReseal.FUNCTION}($1, $2, $3::bytea, $4::bytea, NULL::bytea, NULL::bytea) AS changed`,
          [ctx.orgA.id, documentId, Buffer.from('not the row'), Buffer.from('new')]
        )
      )
      expect(answer.rows[0]?.changed).toBe(false)
    })

    it('lets the door change the two sealed columns and nothing else, and closes it when the function returns', async () => {
      // As the owner of the function (the only role the door admits), by hand: the sealed columns pass, any other column does not
      await raw.query('BEGIN')
      try {
        await raw.query(`SELECT set_config('${FiscalReseal.SETTING}', 'on', true)`)
        await expect(
          raw.query('UPDATE fiscal_documents SET total_cents = total_cents + 1 WHERE id = $1', [
            documentId
          ])
        ).rejects.toMatchObject({
          message: expect.stringContaining('only the sealed columns') as string
        })
      } finally {
        await raw.query('ROLLBACK').catch(() => undefined)
      }
      await raw.query('BEGIN')
      try {
        await raw.query(`SELECT set_config('${FiscalReseal.SETTING}', 'on', true)`)
        await expect(
          raw.query("UPDATE fiscal_documents SET status = 'voided' WHERE id = $1", [documentId])
        ).rejects.toMatchObject({
          message: expect.stringContaining('only the sealed columns') as string
        })
      } finally {
        await raw.query('ROLLBACK').catch(() => undefined)
      }
      // After the function the setting is off: the same transaction cannot go on writing the sealed columns of a decided document
      await raw.query('BEGIN')
      try {
        await raw.query("SELECT set_config('app.organization_ids', $1, true)", [ctx.orgA.id])
        const row = await raw.query<{
          receiver_encrypted: Buffer
          built_payload_encrypted: Buffer | null
        }>(
          'SELECT receiver_encrypted, built_payload_encrypted FROM fiscal_documents WHERE id = $1',
          [documentId]
        )
        const current = row.rows[0]
        const done = await raw.query<{ changed: boolean }>(
          `SELECT ${FiscalReseal.FUNCTION}($1, $2, $3::bytea, $4::bytea, $5::bytea, $5::bytea) AS changed`,
          [
            ctx.orgA.id,
            documentId,
            current?.receiver_encrypted,
            Buffer.from('swapped-by-function'),
            current?.built_payload_encrypted ?? null
          ]
        )
        expect(done.rows[0]?.changed).toBe(true)
        await expect(raw.query(swapSql, [documentId, Buffer.from('direct')])).rejects.toMatchObject(
          {
            message: expect.stringContaining('immutable') as string
          }
        )
      } finally {
        await raw.query('ROLLBACK').catch(() => undefined)
      }
    })
  })

  it('names the function and the setting as the migration does', async () => {
    const { rows } = await raw.query<{ n: string }>(
      'SELECT proname AS n FROM pg_proc WHERE proname = $1',
      [FiscalReseal.FUNCTION]
    )
    expect(rows).toHaveLength(1)
    const migration = await raw.query<{ src: string }>(
      'SELECT prosrc AS src FROM pg_proc WHERE proname = $1',
      [FiscalReseal.FUNCTION]
    )
    expect(migration.rows[0]?.src).toContain(`'${FiscalReseal.SETTING}'`)
  })
})
