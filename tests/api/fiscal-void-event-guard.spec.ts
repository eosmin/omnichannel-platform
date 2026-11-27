import { randomBytes, randomInt, randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import pg from 'pg'

import { CredentialCipher } from '@platform/core/crypto'
import { connectionUrls, DatabaseRoles, type OwnerClient } from '@platform/core/database-testing'

import { createOrder } from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'

// The guard and the check of the table for the sealed event of an invalidation (D13b-2b-1), as the two roles that write it: one statement per
// transaction, always rolled back (a statement that fails aborts its transaction), in the context of the organization and the store that the
// api and the worker open. Rows are only CREATED through the owner client, so the suite runs the same with row-level security enforced
// (TEST_RLS_ENFORCE=1), where a read or an update of the owner client with no context finds nothing. Taking the new column out of the guard,
// of the check or of the function of the re-seal must fail here.
describe.each([DatabaseRoles.APP, DatabaseRoles.WORKER])(
  'The sealed event of an invalidation, as the role %s',
  role => {
    const prefix = newRunPrefix()
    let app: INestApplication
    let owner: OwnerClient
    let ctx: TestContext
    const raw = new pg.Client({ connectionString: connectionUrls().owner })
    const cipher = new CredentialCipher(randomBytes(32))
    const sealed = (content: Record<string, unknown>): Buffer => Buffer.from(cipher.seal(content))

    beforeAll(async () => {
      owner = ownerClient()
      app = await createTestApp()
      ctx = await seedTestContext(owner, app, prefix)
      await raw.connect()
    })
    afterAll(async () => {
      await raw.end().catch(() => undefined)
      await cleanUp(owner, prefix)
      await app.close()
      await owner.$disconnect()
    })

    const run = async (
      sql: string,
      values: unknown[]
    ): Promise<{ rows: number; first?: Record<string, unknown> } | { refused: string }> => {
      await raw.query('BEGIN')
      try {
        await raw.query(`SET LOCAL ROLE ${role}`)
        await raw.query(
          "SELECT set_config('app.store_ids', $1, true), set_config('app.organization_ids', $2, true)",
          [ctx.storeA.id, ctx.orgA.id]
        )
        const result = await raw.query(sql, values)
        return { rows: result.rowCount ?? 0, first: result.rows[0] as Record<string, unknown> }
      } catch (error) {
        return { refused: (error as Error).message }
      } finally {
        await raw.query('ROLLBACK').catch(() => undefined)
      }
    }
    const refusedWith = (pattern: RegExp): { refused: string } => ({
      refused: expect.stringMatching(pattern) as string
    })

    async function document(status: 'accepted' | 'voided', event?: Buffer): Promise<string> {
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
          receiverEncrypted: new Uint8Array(sealed({ taxId: 'T-1' })),
          totalCents: 1999,
          taxCents: 0,
          ...(status === 'voided'
            ? { voidReason: 'fixture', voidedBy: randomUUID(), voidedAt: new Date() }
            : {}),
          ...(event === undefined ? {} : { voidEventEncrypted: new Uint8Array(event) })
        },
        select: { id: true }
      })
      return row.id
    }

    it('lets the statement that voids write the event', async () => {
      const documentId = await document('accepted')
      expect(
        await run(
          "UPDATE fiscal_documents SET status = 'voided', void_reason = 'r', voided_at = now(), void_event_encrypted = $1 WHERE id = $2",
          [sealed({ event: {}, signature: 'a.b.c' }), documentId]
        )
      ).toMatchObject({ rows: 1 })
    })

    it('lets nothing change or clear the event of a voided row', async () => {
      const documentId = await document('voided', sealed({ event: {}, signature: 'a.b.c' }))
      for (const set of [
        'void_event_encrypted = NULL',
        "void_event_encrypted = '\\x010203'::bytea"
      ]) {
        expect(await run(`UPDATE fiscal_documents SET ${set} WHERE id = $1`, [documentId])).toEqual(
          refusedWith(/voided fiscal document does not change/)
        )
      }
    })

    it('refuses an event on a row that stays accepted', async () => {
      const documentId = await document('accepted')
      expect(
        await run('UPDATE fiscal_documents SET void_event_encrypted = $1 WHERE id = $2', [
          Buffer.from([1, 2, 3]),
          documentId
        ])
      ).toEqual(refusedWith(/immutable|fiscal_documents_void_event_encrypted_chk/))
    })

    it('swaps the event only through the function of the re-seal: the worker may call it, nobody else, and only for its own organization', async () => {
      const current = sealed({ event: { a: 1 }, signature: 'a.b.c' })
      const documentId = await document('voided', current)
      const next = sealed({ event: { a: 1 }, signature: 'a.b.c' })
      const call = (organizationId: string, from: Buffer) =>
        run('SELECT fiscal_reseal_void_event($1, $2, $3, $4) AS changed', [
          organizationId,
          documentId,
          from,
          next
        ])
      if (role === DatabaseRoles.WORKER) {
        expect(await call(ctx.orgA.id, current)).toMatchObject({ first: { changed: true } })
        // Compare-and-swap: a value that is not the one in the row changes nothing
        expect(await call(ctx.orgA.id, Buffer.from([9, 9, 9]))).toMatchObject({
          first: { changed: false }
        })
        // Another organization than the one of the context of the caller
        expect(await call(ctx.orgB.id, current)).toEqual(refusedWith(/not in the context/))
      } else {
        expect(await call(ctx.orgA.id, current)).toEqual(refusedWith(/permission denied/))
      }
    })

    // The guard refuses a write on an accepted row before the check is reached, so the check is proved on its own: it is there, it says what it
    // must, and with the triggers off for one transaction the database still refuses an event on a row that is not voided
    it('holds the check of the table on its own: only a voided row may hold an event', async () => {
      const definition = await raw.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'fiscal_documents_void_event_encrypted_chk'`
      )
      expect(definition.rows[0]?.def).toMatch(/void_event_encrypted IS NULL.*status.*voided/)
      const documentId = await document('accepted')
      await raw.query('BEGIN')
      try {
        await raw.query('ALTER TABLE fiscal_documents DISABLE TRIGGER USER')
        await expect(
          raw.query('UPDATE fiscal_documents SET void_event_encrypted = $1 WHERE id = $2', [
            Buffer.from([1, 2, 3]),
            documentId
          ])
        ).rejects.toThrow(/fiscal_documents_void_event_encrypted_chk/)
      } finally {
        await raw.query('ROLLBACK').catch(() => undefined)
      }
    })

    it('does not let the role set the door by hand and change the event with a plain update', async () => {
      const documentId = await document('voided', sealed({ event: {}, signature: 'a.b.c' }))
      await raw.query('BEGIN')
      try {
        await raw.query(`SET LOCAL ROLE ${role}`)
        await raw.query(
          "SELECT set_config('app.store_ids', $1, true), set_config('app.organization_ids', $2, true)",
          [ctx.storeA.id, ctx.orgA.id]
        )
        await raw.query("SELECT set_config('app.fiscal_reseal', 'on', true)")
        await expect(
          raw.query('UPDATE fiscal_documents SET void_event_encrypted = $1 WHERE id = $2', [
            Buffer.from([1, 2, 3]),
            documentId
          ])
        ).rejects.toThrow(/voided fiscal document does not change/)
      } finally {
        await raw.query('ROLLBACK').catch(() => undefined)
      }
    })
  }
)
