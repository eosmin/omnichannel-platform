import pg from 'pg'

import { connectionUrls, ensureStore, type OwnerClient } from '@platform/core/database-testing'

import { createConsentRecord, createCustomer } from '../builders'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'

// Step 7.2-K2 (migration 20270125300000_consent_records_append_only): what a person said is append-only IN THE DATABASE, for every role,
// the owner of the table included (so each case writes as the owner: no privilege holds a statement back, the trigger does). Allowed:
// an INSERT, the merge moving `customer_id`, `revoked_at` set once, `ip_address` and `user_agent` cleared. Everything else is refused, and
// the only DELETE is the cascade of the customer or of the store.
describe('consent_records is append-only', () => {
  const prefix = newRunPrefix()
  const refused = /CONSENT_RECORD_IMMUTABLE/
  let owner: OwnerClient
  let storeId: string
  let otherStoreId: string

  beforeAll(async () => {
    owner = ownerClient()
    const org = await owner.organization.create({
      data: { name: `${prefix}-a`, slug: `${prefix}-a` }
    })
    storeId = (await ensureStore(owner, org.id, `${prefix}-store-a`)).id
    otherStoreId = (await ensureStore(owner, org.id, `${prefix}-store-b`)).id
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await owner.$disconnect()
  })

  const fresh = (): Promise<{ id: string; customerId: string }> =>
    createConsentRecord(owner, { storeId })

  const rowOf = (id: string) => owner.consentRecord.findUniqueOrThrow({ where: { id } })

  describe('an UPDATE', () => {
    it.each([
      ['purpose', "purpose = 'marketing'"],
      ['legal_basis', "legal_basis = 'consent'"],
      ['granted', 'granted = NOT granted'],
      ['granted_at', "granted_at = now() + interval '1 day'"],
      ['source', "source = 'tampered'"],
      ['created_at', "created_at = now() - interval '9 years'"],
      ['store_id', null]
    ])('refuses to change %s', async (_column, set) => {
      const { id } = await fresh()
      const statement =
        set === null
          ? owner.$executeRawUnsafe(
              'UPDATE consent_records SET store_id = $1 WHERE id = $2',
              otherStoreId,
              id
            )
          : owner.$executeRawUnsafe(`UPDATE consent_records SET ${set} WHERE id = $1`, id)
      await expect(statement).rejects.toThrow(refused)
      const row = await rowOf(id)
      expect(row.purpose).toBe('order_messages')
      expect(row.granted).toBe(true)
      expect(row.storeId).toBe(storeId)
    })

    it('refuses a change of a forbidden column that rides along with an allowed one', async () => {
      const { id } = await fresh()
      await expect(
        owner.$executeRawUnsafe(
          "UPDATE consent_records SET revoked_at = granted_at + interval '1 second', granted = false WHERE id = $1",
          id
        )
      ).rejects.toThrow(refused)
      expect((await rowOf(id)).revokedAt).toBeNull()
    })

    it('lets the merge of customers move customer_id, and its undo move it back', async () => {
      const { id, customerId } = await fresh()
      const survivor = await createCustomer(owner, { storeId })
      await owner.$executeRawUnsafe(
        'UPDATE consent_records SET customer_id = $1 WHERE id = $2',
        survivor.id,
        id
      )
      expect((await rowOf(id)).customerId).toBe(survivor.id)
      await owner.$executeRawUnsafe(
        'UPDATE consent_records SET customer_id = $1 WHERE id = $2',
        customerId,
        id
      )
      expect((await rowOf(id)).customerId).toBe(customerId)
    })

    it('moves customer_id only to a customer of the same store', async () => {
      const { id, customerId } = await fresh()
      const foreign = await createCustomer(owner, { storeId: otherStoreId })
      await expect(
        owner.$executeRawUnsafe(
          'UPDATE consent_records SET customer_id = $1 WHERE id = $2',
          foreign.id,
          id
        )
      ).rejects.toThrow(refused)
      expect((await rowOf(id)).customerId).toBe(customerId)
    })

    it('sets revoked_at to a believable instant: not before the grant, not in the future', async () => {
      const { id } = await fresh()
      await expect(
        owner.$executeRawUnsafe(
          "UPDATE consent_records SET revoked_at = granted_at - interval '1 day' WHERE id = $1",
          id
        )
      ).rejects.toThrow(refused)
      await expect(
        owner.$executeRawUnsafe(
          "UPDATE consent_records SET revoked_at = (now() AT TIME ZONE 'UTC') + interval '2 days' WHERE id = $1",
          id
        )
      ).rejects.toThrow(refused)
      expect((await rowOf(id)).revokedAt).toBeNull()
    })

    it('sets revoked_at once, and never moves or clears it', async () => {
      const { id } = await fresh()
      await owner.$executeRawUnsafe(
        "UPDATE consent_records SET revoked_at = granted_at + interval '1 second' WHERE id = $1",
        id
      )
      const revokedAt = (await rowOf(id)).revokedAt
      expect(revokedAt).not.toBeNull()
      // The erasure writes `revokedAt ?? now`: the same instant again is not a change
      await owner.$executeRawUnsafe(
        'UPDATE consent_records SET revoked_at = revoked_at WHERE id = $1',
        id
      )
      await expect(
        owner.$executeRawUnsafe(
          "UPDATE consent_records SET revoked_at = now() + interval '1 hour' WHERE id = $1",
          id
        )
      ).rejects.toThrow(refused)
      await expect(
        owner.$executeRawUnsafe('UPDATE consent_records SET revoked_at = NULL WHERE id = $1', id)
      ).rejects.toThrow(refused)
      expect((await rowOf(id)).revokedAt).toEqual(revokedAt)
    })

    it('only clears ip_address and user_agent, never writes them', async () => {
      const { id } = await fresh()
      await expect(
        owner.$executeRawUnsafe(
          "UPDATE consent_records SET ip_address = '203.0.113.7' WHERE id = $1",
          id
        )
      ).rejects.toThrow(refused)
      await expect(
        owner.$executeRawUnsafe("UPDATE consent_records SET user_agent = 'x' WHERE id = $1", id)
      ).rejects.toThrow(refused)
      const withBoth = await owner.consentRecord.create({
        data: {
          storeId,
          customerId: (await createCustomer(owner, { storeId })).id,
          purpose: 'order_messages',
          legalBasis: 'contract',
          granted: true,
          source: 'staff',
          ipAddress: '203.0.113.7',
          userAgent: 'a browser'
        },
        select: { id: true }
      })
      await expect(
        owner.$executeRawUnsafe(
          "UPDATE consent_records SET ip_address = '198.51.100.9' WHERE id = $1",
          withBoth.id
        )
      ).rejects.toThrow(refused)
      await owner.$executeRawUnsafe(
        "UPDATE consent_records SET revoked_at = (now() AT TIME ZONE 'UTC'), ip_address = NULL, user_agent = NULL WHERE id = $1",
        withBoth.id
      )
      const cleared = await rowOf(withBoth.id)
      expect(cleared.ipAddress).toBeNull()
      expect(cleared.userAgent).toBeNull()
      expect(cleared.revokedAt).not.toBeNull()
      // And once cleared they are not written again
      await expect(
        owner.$executeRawUnsafe(
          "UPDATE consent_records SET ip_address = '203.0.113.7' WHERE id = $1",
          withBoth.id
        )
      ).rejects.toThrow(refused)
    })
  })

  describe('a DELETE or a TRUNCATE', () => {
    it('refuses a statement that deletes the row itself, to the owner too', async () => {
      const { id } = await fresh()
      await expect(
        owner.$executeRawUnsafe('DELETE FROM consent_records WHERE id = $1', id)
      ).rejects.toThrow(refused)
      expect(await owner.consentRecord.count({ where: { id } })).toBe(1)
    })

    it('refuses a TRUNCATE, and has the trigger that does it', async () => {
      const triggers = await owner.$queryRawUnsafe<
        { tgname: string; truncate: boolean; row: boolean }[]
      >(
        `SELECT tgname, (tgtype & 32) <> 0 AS "truncate", (tgtype & 1) <> 0 AS "row" FROM pg_trigger
         WHERE tgrelid = 'consent_records'::regclass AND NOT tgisinternal ORDER BY tgname`
      )
      expect(triggers).toEqual([
        { tgname: 'trg_consent_records_append_only', truncate: false, row: true },
        { tgname: 'trg_consent_records_no_truncate', truncate: true, row: false }
      ])
      // Run, inside a transaction that is rolled back whatever happens (a missing trigger would empty the table of every other suite,
      // so the trigger count above comes first)
      const client = new pg.Client({ connectionString: connectionUrls().owner })
      await client.connect()
      try {
        await client.query('BEGIN')
        await expect(client.query('TRUNCATE consent_records')).rejects.toThrow(refused)
      } finally {
        await client.query('ROLLBACK').catch(() => undefined)
        await client.end()
      }
    })

    it('refuses a delete that another trigger makes while the customer and the store are alive', async () => {
      const { id } = await fresh()
      const client = new pg.Client({ connectionString: connectionUrls().owner })
      await client.connect()
      try {
        // Inside a transaction that is rolled back: a table with a trigger that deletes the row, at depth 2, as a side effect
        await client.query('BEGIN')
        await client.query('CREATE TABLE k2_probe (note text)')
        await client.query(
          `CREATE FUNCTION k2_probe_delete() RETURNS trigger LANGUAGE plpgsql AS $$
           BEGIN DELETE FROM consent_records WHERE id = NEW.note; RETURN NEW; END $$`
        )
        await client.query(
          'CREATE TRIGGER k2_probe_trg AFTER INSERT ON k2_probe FOR EACH ROW EXECUTE FUNCTION k2_probe_delete()'
        )
        await expect(client.query('INSERT INTO k2_probe VALUES ($1)', [id])).rejects.toThrow(
          refused
        )
      } finally {
        await client.query('ROLLBACK').catch(() => undefined)
        await client.end()
      }
      expect(await owner.consentRecord.count({ where: { id } })).toBe(1)
    })

    it('lets the row go with its customer', async () => {
      const { id, customerId } = await fresh()
      await owner.customer.delete({ where: { id: customerId } })
      expect(await owner.consentRecord.count({ where: { id } })).toBe(0)
    })

    it('lets the rows go with their store', async () => {
      const org = await owner.organization.create({
        data: { name: `${prefix}-c`, slug: `${prefix}-c` }
      })
      const store = await ensureStore(owner, org.id, `${prefix}-store-c`)
      const { id } = await createConsentRecord(owner, { storeId: store.id })
      await owner.store.delete({ where: { id: store.id } })
      expect(await owner.consentRecord.count({ where: { id } })).toBe(0)
    })
  })

  it('keeps the row-level policy of the table', async () => {
    const policies = await owner.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM pg_policy WHERE polrelid = 'consent_records'::regclass`
    )
    expect(policies[0]?.n).toBeGreaterThanOrEqual(1)
  })
})
