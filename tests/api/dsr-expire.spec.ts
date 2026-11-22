import { randomUUID } from 'node:crypto'

import type { Queue } from 'bullmq'
import type { PinoLogger } from 'nestjs-pino'
import pg from 'pg'

import type { AuditService } from '@platform/core/audit-module'
import { type DsrConfig, dsrEmailHash } from '@platform/core/compliance'
import { encrypt, hashToken, parseEncryptionKey } from '@platform/core/crypto'
import { JobContext, PrismaService } from '@platform/core/database'
import { connectionUrls } from '@platform/core/database-testing'
import type { DomainEvents } from '@platform/core/event-bus'
import { type SendEmailJob } from '@platform/core/queues'

import { DsrExpireSweeper } from '../../apps/worker/src/compliance/dsr-expire.sweeper'

// Step 7.2-H1b, the sweep of the data requests that were never confirmed, against the REAL database as the role of the worker. Two stores of
// one organization each have requests waiting; the cases prove which ones the sweep closes, that it clears the address and its hash, that
// the person is told once, and that no customer is touched.
const CONFIG: DsrConfig = {
  enabled: true,
  hashKey: 'h'.repeat(64),
  encryptionKeyHex: 'a'.repeat(64)
}

describe('the sweep of data requests whose verification expired', () => {
  const dbs: PrismaService[] = []
  let sweeper: DsrExpireSweeper
  let owner: pg.Client
  const runId = randomUUID().slice(0, 8)
  const org = `org-exp-${runId}`
  const storeA = `store-exp-a-${runId}`
  const storeB = `store-exp-b-${runId}`
  const customerA = `cust-exp-a-${runId}`
  const mails: { to: string; data: Record<string, unknown> }[] = []
  let failNextMail = false
  const audit = { log: jest.fn() }
  const email = (name: string): string => `exp-${runId}-${name}@example.com`

  async function insertRequest(
    id: string,
    store: string,
    status: string,
    to: string,
    token: 'expired' | 'live' | 'used' | 'none'
  ): Promise<void> {
    await owner.query(
      `INSERT INTO data_subject_requests (id, organization_id, store_id, type, status, subject_type, subject_email_hash, notify_to_encrypted, subject_customer_ids, deadline_at)
       VALUES ($1, $2, $3, 'erasure', $4, 'customer', $5, $6, ARRAY[$7]::text[], now() + interval '30 days')`,
      [
        id,
        org,
        store,
        status,
        dsrEmailHash(to, CONFIG.hashKey),
        encrypt(to, parseEncryptionKey(CONFIG.encryptionKeyHex)),
        customerA
      ]
    )
    if (token === 'none') return
    const expires = token === 'live' ? `now() + interval '3 days'` : `now() - interval '1 day'`
    await owner.query(
      `INSERT INTO verification_tokens (id, type, token_hash, subject, expires_at, used_at)
       VALUES ($1, 'dsr_verification', $2, $3, ${expires}, ${token === 'used' ? 'now()' : 'NULL'})`,
      [randomUUID(), hashToken(`token-${id}`), id]
    )
  }
  const rowOf = async (id: string) =>
    (
      await owner.query<{
        status: string
        rejection_reason: string | null
        notify_to_encrypted: Buffer | null
        subject_email_hash: string | null
        completed_at: Date | null
        subject_customer_ids: string[]
      }>(
        `SELECT status, rejection_reason, notify_to_encrypted, subject_email_hash, completed_at, subject_customer_ids
         FROM data_subject_requests WHERE id = $1`,
        [id]
      )
    ).rows[0]

  beforeAll(async () => {
    owner = new pg.Client({ connectionString: connectionUrls().owner })
    await owner.connect()
    await owner.query(
      `INSERT INTO organizations (id, name, slug, updated_at) VALUES ($1, 'fixture', $1, now())`,
      [org]
    )
    for (const store of [storeA, storeB]) {
      await owner.query(
        `INSERT INTO stores (id, organization_id, name, slug, default_locale, updated_at) VALUES ($1, $2, 'fixture', $1, $3, now())`,
        [store, org, store === storeB ? 'en' : 'es']
      )
    }
    await owner.query(
      `INSERT INTO customers (id, store_id, name, email, updated_at) VALUES ($1, $2, 'Ana', $3, now())`,
      [customerA, storeA, email('customer')]
    )
    const workerDb = new PrismaService({ databaseUrl: connectionUrls().worker })
    dbs.push(workerDb)
    const mailQueue = {
      add: (_name: string, data: SendEmailJob) => {
        if (failNextMail) {
          failNextMail = false
          return Promise.reject(new Error('queue is down'))
        }
        mails.push({ to: [data.to].flat().join(','), data: data.data })
        return Promise.resolve()
      }
    }
    sweeper = new DsrExpireSweeper(
      workerDb,
      new JobContext(workerDb),
      audit as unknown as AuditService,
      { publish: jest.fn() } as unknown as DomainEvents,
      mailQueue as unknown as Queue<SendEmailJob>,
      CONFIG,
      { setContext: jest.fn(), error: jest.fn() } as unknown as PinoLogger
    )
  })

  afterAll(async () => {
    // By the ids of this run: the requests (their tokens first) and the rows of the organization
    const requests = await owner.query<{ id: string }>(
      'SELECT id FROM data_subject_requests WHERE organization_id = $1',
      [org]
    )
    const tokens = await owner.query<{ id: string }>(
      'SELECT id FROM verification_tokens WHERE subject = ANY($1)',
      [requests.rows.map(row => row.id)]
    )
    await owner.query('DELETE FROM verification_tokens WHERE id = ANY($1)', [
      tokens.rows.map(row => row.id)
    ])
    await owner.query('DELETE FROM data_subject_requests WHERE organization_id = $1', [org])
    await owner.query('DELETE FROM customers WHERE store_id = ANY($1)', [[storeA, storeB]])
    await owner.query('DELETE FROM stores WHERE organization_id = $1', [org])
    await owner.query('DELETE FROM organizations WHERE id = $1', [org])
    await owner.end()
    for (const db of dbs) await db.onModuleDestroy?.()
  })

  beforeEach(() => {
    mails.length = 0
    audit.log.mockClear()
    failNextMail = false
  })

  it('closes the requests whose link expired unused, in every store, and leaves the others as they are', async () => {
    const ids = {
      expiredA: `req-expired-a-${runId}`,
      expiredB: `req-expired-b-${runId}`,
      noToken: `req-notoken-${runId}`,
      live: `req-live-${runId}`,
      used: `req-used-${runId}`,
      inReview: `req-review-${runId}`
    }
    await insertRequest(ids.expiredA, storeA, 'pending_verification', email('a'), 'expired')
    await insertRequest(ids.expiredB, storeB, 'pending_verification', email('b'), 'expired')
    await insertRequest(ids.noToken, storeA, 'pending_verification', email('n'), 'none')
    await insertRequest(ids.live, storeA, 'pending_verification', email('l'), 'live')
    await insertRequest(ids.used, storeA, 'pending_verification', email('u'), 'used')
    await insertRequest(ids.inReview, storeA, 'manual_review', email('r'), 'expired')

    const report = await sweeper.run()

    expect(report.failed).toBe(0)
    expect(report.expired).toBe(4)
    for (const id of [ids.expiredA, ids.expiredB, ids.noToken, ids.used]) {
      const row = await rowOf(id)
      expect(row).toMatchObject({
        status: 'rejected',
        rejection_reason: 'verification_expired',
        notify_to_encrypted: null,
        subject_email_hash: null
      })
      expect(row?.completed_at).not.toBeNull()
    }
    // A live link waits; a request already in review is nobody's to expire. A request that pends with its token already spent has no link
    // left to wait for (verifying moves the request in the same transaction, so this is a request that was never moved): it closes too
    expect((await rowOf(ids.live))?.status).toBe('pending_verification')
    expect((await rowOf(ids.live))?.notify_to_encrypted).not.toBeNull()
    expect((await rowOf(ids.inReview))?.status).toBe('manual_review')

    // The person is told once, in the language of the store; the mail carries the kind and no other data
    expect(mails.map(mail => mail.to).sort()).toEqual(
      [email('a'), email('b'), email('n'), email('u')].sort()
    )
    expect(mails.find(mail => mail.to === email('b'))?.data).toEqual({
      outcome: 'expired',
      requestType: 'erasure'
    })
    // No customer was touched or named
    const customer = await owner.query<{ erased_at: Date | null; email: string }>(
      'SELECT erased_at, email FROM customers WHERE id = $1',
      [customerA]
    )
    expect(customer.rows[0]).toMatchObject({ erased_at: null, email: email('customer') })
    // The audit entries hold ids and the kind
    expect(audit.log).toHaveBeenCalledTimes(4)
    expect(JSON.stringify(audit.log.mock.calls)).not.toContain('@example.com')
  })

  it('does nothing the second time: a closed request is not closed again and the person is not mailed twice', async () => {
    const report = await sweeper.run()

    expect(report).toEqual({ expired: 0, failed: 0 })
    expect(mails).toHaveLength(0)
  })

  it('leaves a request open when its mail cannot be queued, and closes it in the next run', async () => {
    const id = `req-mailfail-${runId}`
    await insertRequest(id, storeA, 'pending_verification', email('f'), 'expired')
    failNextMail = true

    const first = await sweeper.run()

    expect(first).toEqual({ expired: 0, failed: 1 })
    const waiting = await rowOf(id)
    expect(waiting?.status).toBe('pending_verification')
    expect(waiting?.notify_to_encrypted).not.toBeNull()

    const second = await sweeper.run()

    expect(second).toEqual({ expired: 1, failed: 0 })
    expect((await rowOf(id))?.status).toBe('rejected')
    expect(mails.map(mail => mail.to)).toEqual([email('f')])
  })

  it('closes a request whose sealed address cannot be opened, without a mail, and does not keep the sweep from the others', async () => {
    const broken = `req-broken-${runId}`
    const fine = `req-fine-${runId}`
    await insertRequest(broken, storeA, 'pending_verification', email('x'), 'expired')
    await owner.query(`UPDATE data_subject_requests SET notify_to_encrypted = $2 WHERE id = $1`, [
      broken,
      Buffer.from('not a sealed address')
    ])
    await insertRequest(fine, storeA, 'pending_verification', email('y'), 'expired')

    const report = await sweeper.run()

    expect(report).toEqual({ expired: 2, failed: 0 })
    expect((await rowOf(broken))?.status).toBe('rejected')
    expect((await rowOf(broken))?.notify_to_encrypted).toBeNull()
    expect(mails.map(mail => mail.to)).toEqual([email('y')])
  })

  it('does not close a request that is no longer waiting for its link (the person confirmed it)', async () => {
    const id = `req-race-${runId}`
    await insertRequest(id, storeA, 'pending_verification', email('race'), 'expired')
    // Confirmed: the request moved on and its token is expired, but nothing is waiting any more
    await owner.query(`UPDATE data_subject_requests SET status = 'manual_review' WHERE id = $1`, [
      id
    ])

    const report = await sweeper.run()

    expect(report.expired).toBe(0)
    expect((await rowOf(id))?.status).toBe('manual_review')
  })
})
