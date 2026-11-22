import { randomUUID } from 'node:crypto'

import type { Queue } from 'bullmq'
import type { PinoLogger } from 'nestjs-pino'
import pg from 'pg'

import type { AuditService } from '@platform/core/audit-module'
import { type DsrConfig, dsrEmailHash, sealDsrIntake } from '@platform/core/compliance'
import { hashToken } from '@platform/core/crypto'
import { JobContext, PrismaService } from '@platform/core/database'
import { connectionUrls } from '@platform/core/database-testing'
import { DsrType } from '@platform/core/domain'
import type { SendEmailJob } from '@platform/core/queues'

import { DsrVerifyService } from '../../apps/api/src/modules/compliance/dsr-verify.service'
import { DsrIntakeWorker } from '../../apps/worker/src/compliance/dsr-intake.worker'

// Step 7.2-H1a, the tenancy of the public data request flow against the REAL database, as the roles the code runs as (the worker for the
// intake, the api for the verification). Two stores of one organization each have a customer with the SAME address, and the cases prove that
// one store's request never carries, sees or moves the other's: the worker finds the customers of ITS store only (a raw SQL that the
// mocks of the unit specs cannot test), the check for an open request is per store, and the token of one request moves that request alone.
// Each case also holds with row-level security off (the database of a laptop), because the filters of the code are the first lock.
const CONFIG: DsrConfig = {
  enabled: true,
  hashKey: 'h'.repeat(64),
  encryptionKeyHex: 'a'.repeat(64)
}

describe('the public data request flow, tenancy against the database', () => {
  const dbs: PrismaService[] = []
  let worker: DsrIntakeWorker
  let verify: DsrVerifyService
  let owner: pg.Client
  const runId = randomUUID().slice(0, 8)
  const mails: { data: Record<string, unknown> }[] = []
  const email = `it-${runId}-ana@example.com`
  const org = `org-${runId}`
  const storeA = `store-a-${runId}`
  const storeB = `store-b-${runId}`
  const storeC = `store-c-${runId}` // a store with no customer of that address
  const keyOf = (store: string): string => `dsr-key-${store}-${'k'.repeat(16)}`
  const customerA = `cust-a-${runId}`
  const customerAErased = `cust-a-erased-${runId}`
  const customerB = `cust-b-${runId}`

  const sealed = (store: string): string =>
    sealDsrIntake(
      {
        storeKey: keyOf(store),
        type: DsrType.ACCESS,
        email: ` ${email.toUpperCase()} `,
        locale: 'es'
      },
      CONFIG.encryptionKeyHex
    )
  const requestsOf = async (store: string) =>
    (
      await owner.query<{
        id: string
        status: string
        store_id: string
        subject_customer_ids: string[]
        subject_email_hash: string | null
        notify_to_encrypted: Buffer | null
      }>(
        `SELECT id, status, store_id, subject_customer_ids, subject_email_hash, notify_to_encrypted
         FROM data_subject_requests WHERE store_id = $1 ORDER BY requested_at`,
        [store]
      )
    ).rows
  async function insertRequest(id: string, store: string, hash: string): Promise<void> {
    await owner.query(
      `INSERT INTO data_subject_requests (id, organization_id, store_id, type, status, subject_type, subject_email_hash, subject_customer_ids, deadline_at)
       VALUES ($1, $2, $3, 'access', 'pending_verification', 'customer', $4, ARRAY[$5]::text[], now() + interval '30 days')`,
      [id, org, store, hash, store === storeB ? customerB : customerA]
    )
  }
  async function insertToken(request: string, raw: string): Promise<void> {
    await owner.query(
      `INSERT INTO verification_tokens (id, type, token_hash, subject, expires_at)
       VALUES ($1, 'dsr_verification', $2, $3, now() + interval '7 days')`,
      [randomUUID(), hashToken(raw), request]
    )
  }

  beforeAll(async () => {
    owner = new pg.Client({ connectionString: connectionUrls().owner })
    await owner.connect()
    await owner.query(
      `INSERT INTO organizations (id, name, slug, updated_at) VALUES ($1, 'fixture', $1, now())`,
      [org]
    )
    for (const store of [storeA, storeB, storeC]) {
      await owner.query(
        `INSERT INTO stores (id, organization_id, name, slug, dsr_public_key, updated_at) VALUES ($1, $2, 'fixture', $1, $3, now())`,
        [store, org, keyOf(store)]
      )
    }
    for (const [id, store, erased] of [
      [customerA, storeA, false],
      [customerAErased, storeA, true],
      [customerB, storeB, false]
    ] as const) {
      await owner.query(
        `INSERT INTO customers (id, store_id, name, email, erased_at, updated_at) VALUES ($1, $2, 'Ana', $3, $4, now())`,
        [id, store, id === customerAErased ? `  ${email}\t` : email, erased ? new Date() : null]
      )
    }
    const workerDb = new PrismaService({ databaseUrl: connectionUrls().worker })
    const apiDb = new PrismaService({ databaseUrl: connectionUrls().app })
    dbs.push(workerDb, apiDb)
    const audit = { log: jest.fn() }
    const mailQueue = {
      add: (_name: string, data: Record<string, unknown>) => {
        mails.push({ data })
        return Promise.resolve()
      }
    }
    // Real database, real roles; the queue, the audit and the logger are the ports that are not under test
    worker = new DsrIntakeWorker(
      workerDb,
      new JobContext(workerDb),
      audit as unknown as AuditService,
      mailQueue as unknown as Queue<SendEmailJob>,
      { frontendUrl: 'https://app.example.com' },
      CONFIG,
      { setContext: jest.fn(), info: jest.fn() } as unknown as PinoLogger
    )
    verify = new DsrVerifyService(apiDb, audit as unknown as AuditService, CONFIG)
  })

  afterAll(async () => {
    // The tokens of this run, by their ids (the worker made some, the cases made others): a delete by another column would be a wide one
    const tokens = await owner.query<{ id: string }>(
      'SELECT id FROM verification_tokens WHERE subject IN (SELECT id FROM data_subject_requests WHERE organization_id = $1)',
      [org]
    )
    await owner.query('DELETE FROM verification_tokens WHERE id = ANY($1)', [
      tokens.rows.map(row => row.id)
    ])
    await owner.query('DELETE FROM data_subject_requests WHERE organization_id = $1', [org])
    await owner.query('DELETE FROM customers WHERE store_id = ANY($1)', [[storeA, storeB, storeC]])
    await owner.query('DELETE FROM stores WHERE organization_id = $1', [org])
    await owner.query('DELETE FROM organizations WHERE id = $1', [org])
    await owner.end()
    for (const db of dbs) await db.onModuleDestroy?.()
  })

  beforeEach(() => {
    mails.length = 0
  })

  it('(a) writes the request of the store of the key with ONLY the customers of that store that are not erased', async () => {
    await expect(worker.handle(sealed(storeA))).resolves.toBe('created')

    const rows = await requestsOf(storeA)
    expect(rows).toHaveLength(1)
    // The customer of store B has the same address and is not in the list; the erased customer of store A is not either, even though its
    // stored address has white space and a tab around it
    expect(rows[0]?.subject_customer_ids).toEqual([customerA])
    expect(rows[0]?.status).toBe('pending_verification')
    expect(rows[0]?.notify_to_encrypted).not.toBeNull()
    expect(await requestsOf(storeB)).toEqual([])
    expect(mails).toHaveLength(1)
  })

  it('(b) looks for an open request in its own store: the one of store B with the same address does not make the request of A a duplicate, and the one of A does', async () => {
    const hash = dsrEmailHash(email, CONFIG.hashKey)
    await insertRequest(`req-b-${runId}`, storeB, hash)
    // Store C has no customer of the address (B has one): nothing is written for it, whoever else is open
    await expect(worker.handle(sealed(storeC))).resolves.toBe('no_customer')
    expect(await requestsOf(storeC)).toEqual([])

    await expect(worker.handle(sealed(storeA))).resolves.toBe('duplicate') // A's own, from the case above
    const b = await requestsOf(storeB)
    expect(b).toHaveLength(1)
    expect(b[0]).toMatchObject({ id: `req-b-${runId}`, status: 'pending_verification' })
  })

  it('(b2) takes the request of A even while B has one open (B alone has an open request)', async () => {
    await owner.query('DELETE FROM data_subject_requests WHERE store_id = $1', [storeA])
    mails.length = 0

    await expect(worker.handle(sealed(storeA))).resolves.toBe('created')
    expect((await requestsOf(storeA))[0]?.subject_customer_ids).toEqual([customerA])
    expect(mails).toHaveLength(1)
  })

  it('(c) confirms the request of the token and no other: the token of A moves the request of A, and B stays waiting', async () => {
    const a = (await requestsOf(storeA))[0]
    const b = (await requestsOf(storeB))[0]
    const tokenA = `A${'a'.repeat(42)}`
    const tokenB = `B${'b'.repeat(42)}`
    await insertToken(a?.id ?? '', tokenA)
    await insertToken(b?.id ?? '', tokenB)

    await expect(verify.verify({ token: tokenA })).resolves.toEqual({ verified: true })

    expect((await requestsOf(storeA))[0]?.status).toBe('manual_review')
    expect((await requestsOf(storeB))[0]?.status).toBe('pending_verification')
    const used = await owner.query<{ token_hash: string; used_at: Date | null }>(
      'SELECT token_hash, used_at FROM verification_tokens WHERE token_hash = ANY($1)',
      [[hashToken(tokenA), hashToken(tokenB)]]
    )
    expect(used.rows.find(row => row.token_hash === hashToken(tokenA))?.used_at).not.toBeNull()
    expect(used.rows.find(row => row.token_hash === hashToken(tokenB))?.used_at).toBeNull()
    // The same token again opens nothing
    await expect(verify.verify({ token: tokenA })).rejects.toMatchObject({
      code: 'DSR_VERIFICATION_INVALID'
    })
  })
})
