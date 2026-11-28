import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import pg from 'pg'

import { connectionUrls, DatabaseRoles, type OwnerClient } from '@platform/core/database-testing'

import { createOrder } from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'

// The guard of the deliveries of the files of a fiscal document (D13b-2b-2), as the two roles that write them: one statement per transaction,
// always rolled back, in the context of the organization and the store that the api and the worker open. Rows are only CREATED through the owner
// client, so the suite runs the same with row-level security enforced (TEST_RLS_ENFORCE=1). A delivery is a record of what a receiver was given:
// it is never deleted, and the only change it takes is one not sent becoming a hand delivery, with who and when and nothing else of the row
// different (the subject included). Taking the guard, a column of its list or the unique key away must fail here.
describe.each([DatabaseRoles.APP, DatabaseRoles.WORKER])(
  'The deliveries of fiscal documents, as the role %s',
  role => {
    const prefix = newRunPrefix()
    let app: INestApplication
    let owner: OwnerClient
    let ctx: TestContext
    const raw = new pg.Client({ connectionString: connectionUrls().owner })

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
    ): Promise<{ rows: number } | { refused: string }> => {
      await raw.query('BEGIN')
      try {
        await raw.query(`SET LOCAL ROLE ${role}`)
        await raw.query(
          "SELECT set_config('app.store_ids', $1, true), set_config('app.organization_ids', $2, true)",
          [ctx.storeA.id, ctx.orgA.id]
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

    // A delivery of the given subject, not sent unless said, for a document of its own
    async function delivery(
      over: { subject?: string; sent?: boolean; documentId?: string } = {}
    ): Promise<{ id: string; documentId: string }> {
      const order = await createOrder(owner, { storeId: ctx.storeA.id })
      const documentId =
        over.documentId ??
        (
          await owner.fiscalDocument.create({
            data: {
              organizationId: ctx.orgA.id,
              storeId: ctx.storeA.id,
              orderId: order.id,
              sequenceNumber: Math.floor(1_000_000 + Math.random() * 1_000_000_000),
              documentType: 'pending',
              status: 'accepted',
              providerId: 'simulator',
              environment: 'sandbox',
              issuerSnapshot: {},
              linesSnapshot: { lines: [] },
              receiverEncrypted: new Uint8Array([1]),
              totalCents: 1999,
              taxCents: 0
            },
            select: { id: true }
          })
        ).id
      const row = await owner.fiscalDelivery.create({
        data: {
          organizationId: ctx.orgA.id,
          storeId: ctx.storeA.id,
          documentId,
          orderId: order.id,
          subject: over.subject ?? 'document',
          ...(over.sent === true
            ? { status: 'sent', route: 'email' }
            : { status: 'not_sent', route: 'none', reason: 'no_channel' })
        },
        select: { id: true }
      })
      return { id: row.id, documentId }
    }
    const HAND = `status = 'sent', route = 'manual', hand_means = 'download', handed_over_by = $2, handed_over_at = now()`

    it('is never deleted, by anybody', async () => {
      const { id } = await delivery()
      expect(await run('DELETE FROM fiscal_deliveries WHERE id = $1', [id])).toEqual(
        refusedWith(/is never deleted/)
      )
      expect(await owner.fiscalDelivery.count({ where: { id } })).toBe(1)
    })

    it('lets a delivery that was not sent become a hand delivery, and keeps why it was not sent', async () => {
      const { id } = await delivery()
      expect(
        await run(`UPDATE fiscal_deliveries SET ${HAND} WHERE id = $1`, [id, randomUUID()])
      ).toEqual({ rows: 1 })
    })

    it('lets the hand delivery of an invalidation be recorded the same way', async () => {
      const { id } = await delivery({ subject: 'void' })
      expect(
        await run(
          `UPDATE fiscal_deliveries SET status = 'sent', route = 'manual', hand_means = 'answer', handed_over_by = $2, handed_over_at = now() WHERE id = $1`,
          [id, randomUUID()]
        )
      ).toEqual({ rows: 1 })
    })

    it('refuses to change a delivery that was sent, or a hand delivery already recorded', async () => {
      const sent = await delivery({ sent: true })
      for (const set of [
        `status = 'not_sent', route = 'none', reason = 'no_channel'`,
        `route = 'channel'`,
        `created_at = now()`
      ]) {
        expect(await run(`UPDATE fiscal_deliveries SET ${set} WHERE id = $1`, [sent.id])).toEqual(
          refusedWith(/only changes from not sent to given by hand/)
        )
      }
      const manual = await delivery()
      await owner.$executeRaw`UPDATE fiscal_deliveries SET status = 'sent', route = 'manual', hand_means = 'paper', handed_over_by = 'u', handed_over_at = now() WHERE id = ${manual.id}`
      expect(
        await run(`UPDATE fiscal_deliveries SET hand_means = 'download' WHERE id = $1`, [manual.id])
      ).toEqual(refusedWith(/only changes from not sent to given by hand/))
    })

    it('lets nothing else of the row move with the hand delivery: not the subject, the document, the store, the reason', async () => {
      const { id, documentId } = await delivery()
      for (const set of [
        `subject = 'void'`,
        `document_id = 'other'`,
        `store_id = 'other'`,
        `order_id = 'other'`,
        `reason = 'too_large'`
      ]) {
        expect(
          await run(`UPDATE fiscal_deliveries SET ${HAND}, ${set} WHERE id = $1`, [
            id,
            randomUUID()
          ])
        ).toEqual(refusedWith(/only changes from not sent to given by hand|violates/))
      }
      expect(documentId).toBeTruthy()
    })

    it('refuses a hand delivery that names nobody or no means, and keeps one delivery for each document and subject', async () => {
      const { id, documentId } = await delivery()
      expect(
        await run(
          `UPDATE fiscal_deliveries SET status = 'sent', route = 'manual', hand_means = 'download' WHERE id = $1`,
          [id]
        )
      ).toEqual(refusedWith(/violates check|only changes/))
      // A second delivery of the same subject is refused, one of the other subject is the invalidation's own
      await expect(delivery({ documentId })).rejects.toThrow()
      await expect(delivery({ documentId, subject: 'void' })).resolves.toBeDefined()
    })

    it('keeps the reason and the means of an invalidation for an invalidation', async () => {
      const order = await createOrder(owner, { storeId: ctx.storeA.id })
      const base = {
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        orderId: order.id,
        status: 'not_sent',
        route: 'none'
      }
      // A document with its invalidation sent: the delivery of the document itself is free to write
      const { documentId } = await delivery({ subject: 'void', sent: true })
      await expect(
        owner.fiscalDelivery.create({
          data: { ...base, documentId, subject: 'document', reason: 'void_event_unavailable' }
        })
      ).rejects.toThrow(/chk_fiscal_deliveries_void_only|chk_fiscal_deliveries_outcome/)
      await expect(
        owner.fiscalDelivery.create({
          data: { ...base, documentId, subject: 'document', status: 'sent', route: 'manual' }
        })
      ).rejects.toThrow(/chk_fiscal_deliveries_outcome/)
      const fresh = await delivery({ sent: true })
      await expect(
        owner.fiscalDelivery.create({
          data: {
            ...base,
            documentId: fresh.documentId,
            subject: 'void',
            reason: 'void_event_unavailable'
          }
        })
      ).resolves.toBeDefined()
    })
  }
)
