import { randomBytes, randomInt, randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import pg from 'pg'

import { CredentialCipher } from '@platform/core/crypto'
import {
  connectionUrls,
  DatabaseRoles,
  rlsEnforcementRequested,
  type OwnerClient
} from '@platform/core/database-testing'

import { createOrder } from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'

// The lot a document of a contingency is sent in (D16): `fiscal_documents.batch_id` and the table of the lots, as the two roles that write them,
// one statement per transaction, always rolled back, in the context of the organization and the store that the api and the worker open. Rows
// are only CREATED through the owner client, so the suite runs the same with row-level security enforced (TEST_RLS_ENFORCE=1). Taking the
// column out of the guard (in particular out of the list the voiding statement compares), of the check, or the guard of the lots out of the
// table must fail here.
describe.each([DatabaseRoles.APP, DatabaseRoles.WORKER])(
  'The lot of a fiscal document, as the role %s',
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
      values: unknown[],
      organizationId = ctx.orgA.id
    ): Promise<{ rows: number } | { refused: string }> => {
      await raw.query('BEGIN')
      try {
        await raw.query(`SET LOCAL ROLE ${role}`)
        await raw.query(
          "SELECT set_config('app.store_ids', $1, true), set_config('app.organization_ids', $2, true)",
          [ctx.storeA.id, organizationId]
        )
        const result = await raw.query(sql, values)
        return { rows: result.rowCount ?? 0 }
      } catch (error) {
        return { refused: (error as Error).message }
      } finally {
        await raw.query('ROLLBACK').catch(() => undefined)
      }
    }
    const refusedWith = (pattern: RegExp): { refused: string } => ({
      refused: expect.stringMatching(pattern) as string
    })

    async function lot(
      organizationId = ctx.orgA.id
    ): Promise<{ batchId: string; contingencyId: string }> {
      const contingency = await owner.fiscalContingency.create({
        data: {
          organizationId,
          providerId: 'simulator',
          environment: 'sandbox',
          status: 'reported',
          origin: 'user',
          reason: 'fixture',
          eventCode: randomUUID(),
          startedAt: new Date(Date.now() - 4_000),
          endedAt: new Date(Date.now() - 3_000),
          reportedAt: new Date(Date.now() - 2_000),
          windowEndsAt: new Date(Date.now() + 3_600_000)
        },
        select: { id: true }
      })
      const batch = await owner.fiscalContingencyBatch.create({
        data: {
          organizationId,
          contingencyId: contingency.id,
          sequence: 1,
          sendId: randomUUID(),
          documentCount: 1
        },
        select: { id: true }
      })
      return { batchId: batch.id, contingencyId: contingency.id }
    }

    async function document(
      status: 'queued' | 'accepted' | 'voided',
      held: { batchId: string; contingencyId: string } | null
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
          receiverEncrypted: new Uint8Array(sealed({ taxId: 'T-1' })),
          totalCents: 1999,
          taxCents: 0,
          ...(held === null ? {} : { contingencyId: held.contingencyId, batchId: held.batchId }),
          ...(status === 'voided'
            ? { voidReason: 'fixture', voidedBy: randomUUID(), voidedAt: new Date() }
            : {})
        },
        select: { id: true }
      })
      return row.id
    }

    describe('the column of the document', () => {
      it('is written while the document is held', async () => {
        const held = await lot()
        const documentId = await document('queued', {
          contingencyId: held.contingencyId,
          batchId: held.batchId
        })
        const other = await lot()
        expect(
          await run('UPDATE fiscal_documents SET batch_id = $1 WHERE id = $2', [
            other.batchId,
            documentId
          ])
        ).toEqual({ rows: 1 })
      })

      it('is fixed once the document is accepted: neither changed nor cleared', async () => {
        const held = await lot()
        const documentId = await document('accepted', held)
        const other = await lot()
        for (const [set, value] of [
          ['batch_id = $1', other.batchId],
          ['batch_id = $1', null]
        ] as const) {
          expect(
            await run(`UPDATE fiscal_documents SET ${set} WHERE id = $2`, [value, documentId])
          ).toEqual(refusedWith(/accepted fiscal document is immutable/))
        }
      })

      it('is fixed at the moment the document is voided: the statement that voids does not carry it away', async () => {
        const held = await lot()
        const documentId = await document('accepted', held)
        const voidWith = (batch: string | null) =>
          run(
            "UPDATE fiscal_documents SET status = 'voided', void_reason = 'r', voided_by = 'u', voided_at = now(), batch_id = $1 WHERE id = $2",
            [batch, documentId]
          )
        expect(await voidWith(null)).toEqual(refusedWith(/accepted fiscal document is immutable/))
        expect(await voidWith((await lot()).batchId)).toEqual(
          refusedWith(/accepted fiscal document is immutable/)
        )
        // The statement that keeps it goes through
        expect(
          await run(
            "UPDATE fiscal_documents SET status = 'voided', void_reason = 'r', voided_by = 'u', voided_at = now() WHERE id = $1",
            [documentId]
          )
        ).toEqual({ rows: 1 })
      })

      it('is fixed in a voided row', async () => {
        const held = await lot()
        const documentId = await document('voided', held)
        expect(
          await run('UPDATE fiscal_documents SET batch_id = NULL WHERE id = $1', [documentId])
        ).toEqual(refusedWith(/voided fiscal document does not change/))
      })
    })

    describe('the lot', () => {
      it('goes forward: pending, received with its code, processed', async () => {
        const held = await lot()
        expect(
          await run(
            "UPDATE fiscal_contingency_batches SET status = 'received', batch_code = 'CODE-1', sent_at = now() WHERE id = $1",
            [held.batchId]
          )
        ).toEqual({ rows: 1 })
        // Skipping the answer is not going forward
        expect(
          await run(
            "UPDATE fiscal_contingency_batches SET status = 'processed', batch_code = 'CODE-1', sent_at = now(), processed_at = now() WHERE id = $1",
            [held.batchId]
          )
        ).toEqual(refusedWith(/only moves forward|chk_fiscal_contingency_batches_state/))
      })

      it('never goes back, and keeps the code the authority gave', async () => {
        const held = await lot()
        await owner.fiscalContingencyBatch.update({
          where: { id: held.batchId },
          data: { status: 'received', batchCode: 'CODE-2', sentAt: new Date() }
        })
        expect(
          await run(
            "UPDATE fiscal_contingency_batches SET status = 'pending', batch_code = NULL, sent_at = NULL WHERE id = $1",
            [held.batchId]
          )
        ).toEqual(refusedWith(/code the authority gave|only moves forward/))
        expect(
          await run("UPDATE fiscal_contingency_batches SET batch_code = 'OTHER' WHERE id = $1", [
            held.batchId
          ])
        ).toEqual(refusedWith(/code the authority gave/))
      })

      it('keeps what it was made with: its place, its send id, its size and its contingency', async () => {
        const held = await lot()
        for (const set of [
          'sequence = 9',
          `send_id = '${randomUUID()}'`,
          'document_count = 5',
          `contingency_id = '${(await lot()).contingencyId}'`
        ]) {
          expect(
            await run(`UPDATE fiscal_contingency_batches SET ${set} WHERE id = $1`, [held.batchId])
          ).toEqual(refusedWith(/keeps what it was made with/))
        }
      })

      it('is never deleted', async () => {
        const held = await lot()
        const result = await run('DELETE FROM fiscal_contingency_batches WHERE id = $1', [
          held.batchId
        ])
        expect(result).toEqual(refusedWith(/never deleted|permission denied/))
      })

      it("is the organization's: another organization's context does not see it", async () => {
        const held = await lot()
        // Read across organizations: with the policies enforced (TEST_RLS_ENFORCE=1) the other one's context counts none
        if (rlsEnforcementRequested()) {
          expect(
            await run(
              'SELECT 1 FROM fiscal_contingency_batches WHERE id = $1',
              [held.batchId],
              ctx.orgB.id
            )
          ).toEqual({ rows: 0 })
          expect(
            await run(
              'UPDATE fiscal_contingency_batches SET last_error = $2 WHERE id = $1',
              [held.batchId, 'x'],
              ctx.orgB.id
            )
          ).toEqual({ rows: 0 })
        }
        expect(
          await run('SELECT 1 FROM fiscal_contingency_batches WHERE id = $1', [held.batchId])
        ).toEqual({ rows: 1 })
        expect(
          await run('UPDATE fiscal_contingency_batches SET last_error = $2 WHERE id = $1', [
            held.batchId,
            'x'
          ])
        ).toEqual({ rows: 1 })
      })
    })
  }
)
