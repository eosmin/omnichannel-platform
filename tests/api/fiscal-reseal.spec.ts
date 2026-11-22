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
  // A value shaped like a sealed one (version byte, IV, tag), whatever its content
  const shaped = (): Buffer => Buffer.concat([Buffer.from([1]), randomBytes(40)])
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
        receiverEncrypted: new Uint8Array(
          sealer.seal({
            taxId: content['taxId'] ?? 'T-1',
            ...(content['name'] === undefined ? {} : { name: content['name'] })
          })
        ),
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
        status: 'reported',
        reportedAt: new Date(),
        windowEndsAt: new Date(Date.now() + 3_600_000),
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

    // The receiver nobody opens is counted by the re-seal and again by the step of the masks (each is a run of its own over it)
    expect(report.failed).toEqual({ key_mismatch: 2 })
    expect(report.resealed).toBe(1)
    // No mask is guessed for it, and the one that opens has its mask
    const lostMasks = await owner.fiscalDocument.findUniqueOrThrow({ where: { id: lost } })
    expect(lostMasks).toMatchObject({
      receiverMaskedAt: null,
      receiverNameMasked: null,
      receiverTaxIdMasked: null
    })
    expect(
      (await owner.fiscalDocument.findUniqueOrThrow({ where: { id: fine } })).receiverMaskedAt
    ).not.toBeNull()
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

  describe('the masked receiver of the documents', () => {
    const RECEIVER = { taxId: '0614-010101-101-1', name: 'Ana Receptora' }

    it('calculates the masks of a live, an accepted and a voided document with the current key alone, changes nothing else, and a second run finds nothing', async () => {
      const made = {
        live: await makeDocument('queued', newCipher, RECEIVER),
        accepted: await makeDocument('accepted', newCipher, RECEIVER),
        voided: await makeDocument('voided', newCipher, RECEIVER)
      }
      const before = await owner.fiscalDocument.findMany({
        where: { id: { in: Object.values(made) } }
      })
      // No previous key is held: the masks are looked for all the same
      const report = await service(newCipher).run(ctx.orgA.id, unit)

      expect(report.masked).toBe(3)
      // The receiver left unreadable by an earlier case is counted by its code, with no content
      expect(report.failed).toEqual({ key_mismatch: 1 })
      expect(JSON.stringify(report)).not.toMatch(/Receptora|0614/)
      for (const row of before) {
        const after = await owner.fiscalDocument.findUniqueOrThrow({ where: { id: row.id } })
        expect(after.receiverNameMasked).toBe('A***********')
        expect(after.receiverTaxIdMasked).toBe('********1011')
        expect(after.receiverMaskedAt).not.toBeNull()
        // Only the masked columns changed: the sealed ones are the same bytes, and so is the status
        expect(
          Buffer.from(after.receiverEncrypted).equals(Buffer.from(row.receiverEncrypted))
        ).toBe(true)
        expect(after.status).toBe(row.status)
        expect(after.totalCents).toBe(row.totalCents)
      }
      const again = await service(newCipher).run(ctx.orgA.id, unit)
      expect(again.masked).toBe(0)
      expect(again.conflicts).toBe(0)
    })

    it('keeps a receiver with no name or tax id as "calculated" with both masks empty, and a short tax id shows nothing', async () => {
      const none = await makeDocument('accepted', newCipher, { taxId: '12345678' })
      await service(newCipher).run(ctx.orgA.id, unit)
      const row = await owner.fiscalDocument.findUniqueOrThrow({ where: { id: none } })
      // Eight digits are fewer than nine: not a single digit of it is shown
      expect(row).toMatchObject({ receiverNameMasked: null, receiverTaxIdMasked: null })
      expect(row.receiverMaskedAt).not.toBeNull()
    })

    it('says in the table that a mask has one shape and a time, whoever writes it', async () => {
      const id = await makeDocument('queued', newCipher, RECEIVER)
      const write = (name: string | null, tax: string | null, at: string | null) =>
        raw.query(
          'UPDATE fiscal_documents SET receiver_name_masked = $2, receiver_tax_id_masked = $3, receiver_masked_at = $4 WHERE id = $1',
          [id, name, tax, at]
        )
      const now = new Date().toISOString()
      // A mask with no time, a name that shows more than its letter, a tax id that shows more than four digits
      await expect(write('A***********', null, null)).rejects.toMatchObject({ code: '23514' })
      await expect(write('Ana Receptora', null, now)).rejects.toMatchObject({ code: '23514' })
      await expect(write(null, '*****1234567', now)).rejects.toMatchObject({ code: '23514' })
      await expect(write(null, '********12ab', now)).rejects.toMatchObject({ code: '23514' })
      await expect(write('A***********', '********1011', now)).resolves.toBeDefined()
    })
  })

  describe('the guard of a reported contingency', () => {
    it('does not change its responsible by the setting alone, and the function is for the worker only', async () => {
      const row = await owner.fiscalContingency.findFirstOrThrow({
        where: { organizationId: ctx.orgA.id, status: 'reported' }
      })
      const inRole = async (role: string, work: () => Promise<unknown>) => {
        await raw.query('BEGIN')
        try {
          await raw.query(`SET LOCAL ROLE ${role}`)
          await raw.query("SELECT set_config('app.organization_ids', $1, true)", [ctx.orgA.id])
          return await work()
        } finally {
          await raw.query('ROLLBACK').catch(() => undefined)
        }
      }
      await expect(
        inRole('platform_worker', async () => {
          await raw.query(`SELECT set_config('${FiscalReseal.SETTING}', 'on', true)`)
          await raw.query(
            'UPDATE fiscal_contingencies SET responsible_encrypted = $2::bytea WHERE id = $1',
            [row.id, shaped()]
          )
        })
      ).rejects.toMatchObject({ message: expect.stringContaining('does not change') as string })
      await expect(
        inRole('platform_app', () =>
          raw.query('SELECT fiscal_reseal_contingency($1, $2, $3::bytea, $4::bytea)', [
            ctx.orgA.id,
            row.id,
            row.responsibleEncrypted,
            shaped()
          ])
        )
      ).rejects.toMatchObject({ code: '42501' })
    })
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

    it.each([
      [
        'fiscal_documents',
        'accepted',
        [
          'receiver_encrypted',
          'built_payload_encrypted',
          'receiver_name_masked',
          'receiver_tax_id_masked',
          'receiver_masked_at',
          'updated_at'
        ]
      ],
      ['fiscal_contingencies', 'reported', ['responsible_encrypted', 'updated_at']]
    ] as const)(
      'with the door OPEN, %s still refuses a change to every column that is not sealed (%s)',
      async (table, _status, sealed) => {
        const id =
          table === 'fiscal_documents'
            ? documentId
            : (
                await owner.fiscalContingency.findFirstOrThrow({
                  where: { organizationId: ctx.orgA.id }
                })
              ).id
        const columns = await raw.query<{ column_name: string; data_type: string }>(
          'SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2',
          ['public', table]
        )
        // A different value for every type the two tables hold, so each column is changed on its own
        const changed = (name: string, type: string): string | null => {
          if (type === 'text' || type === 'character varying')
            return `'x' || coalesce("${name}", '')`
          if (type === 'integer' || type === 'bigint') return `coalesce("${name}", 0) + 1`
          if (type.startsWith('timestamp')) return `coalesce("${name}", now()) + interval '1 day'`
          if (type === 'jsonb' || type === 'json') return `'{"mutated": true}'::jsonb`
          if (type === 'boolean') return `NOT coalesce("${name}", false)`
          if (type === 'bytea') return `'\\x0102'::bytea`
          return null
        }
        const tried: string[] = []
        for (const { column_name: name, data_type: type } of columns.rows) {
          if ((sealed as readonly string[]).includes(name)) continue
          const value = changed(name, type)
          expect({ name, type, known: value !== null }).toEqual({ name, type, known: true })
          await raw.query('BEGIN')
          try {
            await raw.query(`SELECT set_config('${FiscalReseal.SETTING}', 'on', true)`)
            await expect(
              raw.query(`UPDATE ${table} SET "${name}" = ${value ?? 'NULL'} WHERE id = $1`, [id])
            ).rejects.toMatchObject({
              // The guard's own refusal; a decided row that is given a claim token is refused by the rule of S11a before it
              message: expect.stringMatching(/only the sealed|holds no claim token/) as string
            })
            tried.push(name)
          } finally {
            await raw.query('ROLLBACK').catch(() => undefined)
          }
        }
        // Every column but the sealed ones was tried (a column added later is tried too)
        expect(tried.length).toBe(columns.rows.length - sealed.length)
      }
    )

    const MASKED = ['receiver_name_masked', 'receiver_tax_id_masked', 'receiver_masked_at'] as const
    const maskedValue = (column: string): string =>
      column === 'receiver_masked_at'
        ? 'now()'
        : column === 'receiver_name_masked'
          ? "'Z***********'"
          : "'********9999'"

    it.each(
      ['platform_app', 'platform_worker'].flatMap(role => MASKED.map(column => [role, column]))
    )(
      'with the setting on but no function, %s cannot change %s of a decided document',
      async (role, column) => {
        await expect(
          asRole(role, async () => {
            await raw.query(`SELECT set_config('${FiscalReseal.SETTING}', 'on', true)`)
            await raw.query(
              `UPDATE fiscal_documents SET "${column}" = ${maskedValue(column)} WHERE id = $1`,
              [documentId]
            )
          })
        ).rejects.toMatchObject({ message: expect.stringContaining('immutable') as string })
        // And without the setting at all
        await expect(
          asRole(role, () =>
            raw.query(
              `UPDATE fiscal_documents SET "${column}" = ${maskedValue(column)} WHERE id = $1`,
              [documentId]
            )
          )
        ).rejects.toMatchObject({ message: expect.stringContaining('immutable') as string })
      }
    )

    describe('the function that writes a mask', () => {
      const callMask = (
        role: string,
        organizationId: string,
        receiver: Buffer,
        name: string | null,
        tax: string | null
      ) =>
        asRole(role, () =>
          raw.query<{ changed: boolean }>(
            'SELECT fiscal_mask_document($1, $2, $3::bytea, $4, $5) AS changed',
            [organizationId, documentId, receiver, name, tax]
          )
        )
      const currentReceiver = async (): Promise<Buffer> =>
        Buffer.from(
          (await owner.fiscalDocument.findUniqueOrThrow({ where: { id: documentId } }))
            .receiverEncrypted
        )

      it('is for the worker only, and only for an organization in its context', async () => {
        const receiver = await currentReceiver()
        await expect(
          callMask('platform_app', ctx.orgA.id, receiver, 'A***********', null)
        ).rejects.toMatchObject({ code: '42501' })
        await expect(
          callMask('platform_worker', ctx.orgB.id, receiver, 'A***********', null)
        ).rejects.toMatchObject({ code: '42501' })
      })

      it('writes the three columns once, by compare-and-swap, and leaves a document whose receiver changed alone', async () => {
        const receiver = await currentReceiver()
        const stale = await callMask(
          'platform_worker',
          ctx.orgA.id,
          Buffer.from('not the row'),
          'A***********',
          null
        )
        expect(stale.rows[0]?.changed).toBe(false)
        expect(
          (await owner.fiscalDocument.findUniqueOrThrow({ where: { id: documentId } }))
            .receiverMaskedAt
        ).toBeNull()
        // The write is rolled back by asRole; the owner reads the row as the transaction left it
        await raw.query('BEGIN')
        try {
          await raw.query("SELECT set_config('app.organization_ids', $1, true)", [ctx.orgA.id])
          await raw.query('SET LOCAL ROLE platform_worker')
          const first = await raw.query<{ changed: boolean }>(
            'SELECT fiscal_mask_document($1, $2, $3::bytea, $4, $5) AS changed',
            [ctx.orgA.id, documentId, receiver, 'A***********', '********1011']
          )
          expect(first.rows[0]?.changed).toBe(true)
          // A second call finds the mask already there: it changes nothing
          const second = await raw.query<{ changed: boolean }>(
            'SELECT fiscal_mask_document($1, $2, $3::bytea, $4, $5) AS changed',
            [ctx.orgA.id, documentId, receiver, 'B***********', '********0000']
          )
          expect(second.rows[0]?.changed).toBe(false)
          const row = await raw.query<{ n: string; t: string }>(
            'SELECT receiver_name_masked AS n, receiver_tax_id_masked AS t FROM fiscal_documents WHERE id = $1',
            [documentId]
          )
          expect(row.rows[0]).toEqual({ n: 'A***********', t: '********1011' })
        } finally {
          await raw.query('ROLLBACK').catch(() => undefined)
        }
      })

      it('writes no text that is not a mask (a letter and a fill, a fill and four digits), whatever the worker sends', async () => {
        const receiver = await currentReceiver()
        for (const [name, tax] of [
          ['Ana Receptora', null],
          ['A', null],
          [null, '0614-010101-101-1'],
          [null, '061401010110']
        ] as const) {
          await expect(
            callMask('platform_worker', ctx.orgA.id, receiver, name, tax)
          ).rejects.toMatchObject({ code: '23514' })
        }
        await expect(
          callMask('platform_worker', ctx.orgA.id, receiver, null, null)
        ).resolves.toBeDefined()
      })

      it('puts the setting back to off before it returns, so the same transaction cannot go on writing a decided document', async () => {
        const receiver = await currentReceiver()
        await raw.query('BEGIN')
        try {
          await raw.query("SELECT set_config('app.organization_ids', $1, true)", [ctx.orgA.id])
          await raw.query('SET LOCAL ROLE platform_worker')
          await raw.query('SELECT fiscal_mask_document($1, $2, $3::bytea, $4, $5)', [
            ctx.orgA.id,
            documentId,
            receiver,
            'A***********',
            null
          ])
          const setting = await raw.query<{ v: string }>(
            `SELECT current_setting('${FiscalReseal.SETTING}', true) AS v`
          )
          expect(setting.rows[0]?.v).not.toBe('on')
          await expect(
            raw.query(
              "UPDATE fiscal_documents SET receiver_name_masked = 'Z***********' WHERE id = $1",
              [documentId]
            )
          ).rejects.toMatchObject({ message: expect.stringContaining('immutable') as string })
        } finally {
          await raw.query('ROLLBACK').catch(() => undefined)
        }
      })
    })

    // The door is "the setting is on AND the statement runs as the owner of the re-seal function". The owner is the owner of every definer
    // function, so the door admits whatever one of them writes. What keeps that safe is the closed list below: a new function of this owner
    // that writes to these two tables is refused here until a person has read it.
    it('has exactly three functions of the owner that write a fiscal document or contingency, and the worker cannot make another pass the door', async () => {
      const writers = await raw.query<{ name: string }>(
        `SELECT p.proname AS name
           FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.prorettype <> 'trigger'::regtype
            AND p.prosrc ~* '(update|insert[[:space:]]+into|delete[[:space:]]+from)[[:space:]]+(public\\.)?fiscal_(documents|contingencies)([^a-z_]|$)'
          ORDER BY p.proname`
      )
      expect(writers.rows.map(row => row.name)).toEqual([
        'fiscal_mask_document',
        'fiscal_reseal_contingency',
        'fiscal_reseal_document'
      ])
      // The attempt: the worker sets the setting by hand and calls ANOTHER definer function of the same owner that writes a decided
      // document. The statement runs as the owner, so the door is open; the guard then compares the whole row and refuses what is not a
      // sealed or masked column. (A function that writes only those columns would pass, which is why the list above is closed.)
      await raw.query('BEGIN')
      try {
        await raw.query(
          `CREATE FUNCTION pg_temp.write_total(p_id text) RETURNS void LANGUAGE sql SECURITY DEFINER
             SET search_path = pg_catalog, public, pg_temp
             AS $f$ UPDATE public.fiscal_documents SET total_cents = total_cents + 1 WHERE id = p_id $f$`
        )
        await raw.query('GRANT EXECUTE ON FUNCTION pg_temp.write_total(text) TO platform_worker')
        await raw.query("SELECT set_config('app.organization_ids', $1, true)", [ctx.orgA.id])
        await raw.query('SET LOCAL ROLE platform_worker')
        await raw.query(`SELECT set_config('${FiscalReseal.SETTING}', 'on', true)`)
        await expect(
          raw.query('SELECT pg_temp.write_total($1)', [documentId])
        ).rejects.toMatchObject({
          message: expect.stringContaining('only the sealed and masked columns') as string
        })
      } finally {
        await raw.query('ROLLBACK').catch(() => undefined)
      }
    })

    it('without the setting, the worker and the application roles cannot change a sealed column of a decided document at all', async () => {
      for (const role of ['platform_app', 'platform_worker']) {
        await expect(
          asRole(role, () => raw.query(swapSql, [documentId, shaped()]))
        ).rejects.toMatchObject({ message: expect.stringContaining('immutable') as string })
      }
    })

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

    it('refuses a new receiver that is not shaped like a sealed value and a payload that is erased or invented', async () => {
      const current = await raw.query<{ r: Buffer; p: Buffer | null }>(
        'SELECT receiver_encrypted AS r, built_payload_encrypted AS p FROM fiscal_documents WHERE id = $1',
        [documentId]
      )
      const { r, p } = current.rows[0] ?? { r: Buffer.alloc(0), p: null }
      const call = (newReceiver: Buffer, oldPayload: Buffer | null, newPayload: Buffer | null) =>
        asRole('platform_worker', () =>
          raw.query(
            `SELECT ${FiscalReseal.FUNCTION}($1, $2, $3::bytea, $4::bytea, $5::bytea, $6::bytea)`,
            [ctx.orgA.id, documentId, r, newReceiver, oldPayload, newPayload]
          )
        )
      await expect(call(Buffer.from('junk'), p, p)).rejects.toMatchObject({ code: '23514' })
      await expect(call(shaped(), p, null)).rejects.toMatchObject({ code: '23514' })
      await expect(call(shaped(), null, shaped())).rejects.toMatchObject({ code: '23514' })
    })

    it('swaps nothing when the old bytes are not the ones in the row (compare-and-swap)', async () => {
      const answer = await asRole('platform_worker', () =>
        raw.query<{ changed: boolean }>(
          `SELECT ${FiscalReseal.FUNCTION}($1, $2, $3::bytea, $4::bytea, NULL::bytea, NULL::bytea) AS changed`,
          [ctx.orgA.id, documentId, Buffer.from('not the row'), shaped()]
        )
      )
      expect(answer.rows[0]?.changed).toBe(false)
    })

    it('lets the door change the sealed and the masked columns and nothing else, and closes it when the function returns', async () => {
      // As the owner of the function (the only role the door admits), by hand: the sealed columns pass, any other column does not
      await raw.query('BEGIN')
      try {
        await raw.query(`SELECT set_config('${FiscalReseal.SETTING}', 'on', true)`)
        await expect(
          raw.query('UPDATE fiscal_documents SET total_cents = total_cents + 1 WHERE id = $1', [
            documentId
          ])
        ).rejects.toMatchObject({
          message: expect.stringContaining('only the sealed and masked columns') as string
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
          message: expect.stringContaining('only the sealed and masked columns') as string
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
            shaped(),
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
