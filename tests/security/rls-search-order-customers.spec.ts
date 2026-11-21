import pg from 'pg'

import { connectionUrls, ensureStore, type OwnerClient } from '@platform/core/database-testing'
import { SearchDatabaseErrors } from '@platform/core/domain'

import { createCustomer } from '../builders'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'

// The function behind the text of the orders list (migration 20270122600000, plan B of Row-Level Security): it runs as the owner and
// filters by itself, so
//  - no store in the context RAISES (never an empty answer that looks like "nobody");
//  - the context of one store never reads a customer of another;
//  - an absorbed (merged) customer IS found: the order keeps pointing at who made it, and an erased one is NOT (like every other search);
//  - the answer is bounded (p_limit 1 to 10001, an error outside it, never a clamp) and a pattern is required;
//  - EXECUTE is for the api and the worker roles, and for nobody else.
// The calls are made as platform_app, the role of the api.

const CALL = `SELECT f.id FROM public.rls_search_order_customers($1, $2, $3, $4::integer) AS f`

describe('the customers function of the orders search under row-level security', () => {
  const prefix = newRunPrefix()
  const urls = connectionUrls()
  let owner: OwnerClient
  let appDb: pg.Client
  let storeA = ''
  let storeB = ''
  const tag = `zo${Math.random()
    .toString(36)
    .slice(2, 10)
    .replaceAll(/[^a-z]/g, 'q')}`

  beforeAll(async () => {
    owner = ownerClient()
    const org = await owner.organization.create({
      data: { name: `${prefix}-org`, slug: `${prefix}-org` }
    })
    storeA = (await ensureStore(owner, org.id, `${prefix}-store-a`)).id
    storeB = (await ensureStore(owner, org.id, `${prefix}-store-b`)).id
    appDb = new pg.Client({ connectionString: urls.app })
    await appDb.connect()
  })
  afterAll(async () => {
    await appDb.end()
    await cleanUp(owner, prefix)
    await owner.$disconnect()
  })

  async function inContext<T>(stores: string[], work: () => Promise<T>): Promise<T> {
    await appDb.query('BEGIN')
    try {
      await appDb.query(
        `SELECT set_config('app.store_ids', $1, true), set_config('app.organization_ids', '', true),
                set_config('app.user_id', '', true)`,
        [stores.join(',')]
      )
      const result = await work()
      await appDb.query('COMMIT')
      return result
    } catch (error) {
      await appDb.query('ROLLBACK')
      throw error
    }
  }

  const idsIn = (stores: string[], name: string, email: string, phone: string | null, limit = 50) =>
    inContext(stores, async () =>
      (await appDb.query<{ id: string }>(CALL, [name, email, phone, limit])).rows
        .map(row => row.id)
        .sort()
    )

  it('raises when the transaction has no store in its context', async () => {
    await appDb.query('BEGIN')
    try {
      await expect(appDb.query(CALL, ['%a%', '%a%', null, 5])).rejects.toThrow(
        SearchDatabaseErrors.CONTEXT_REQUIRED
      )
    } finally {
      await appDb.query('ROLLBACK')
    }
  })

  it('finds the customers of the store of the context by name, e-mail and phone, and never those of another store, absorbed ones included', async () => {
    const byName = await createCustomer(owner, { storeId: storeA, name: `Orfeo ${tag}` })
    const byMail = await owner.customer.create({
      data: { storeId: storeA, name: 'Sin nombre', email: `${tag}@example.invalid` },
      select: { id: true }
    })
    const byPhone = await createCustomer(owner, {
      storeId: storeA,
      name: 'Sin telefono',
      phone: '+503 7777-0001'
    })
    const absorbed = await createCustomer(owner, { storeId: storeA, name: `Orfeo ${tag} viejo` })
    await owner.customer.update({ where: { id: absorbed.id }, data: { mergedIntoId: byName.id } })
    const alien = await createCustomer(owner, { storeId: storeB, name: `Orfeo ${tag}` })

    expect(await idsIn([storeA], `%orfeo ${tag}%`, `%orfeo ${tag}%`, null)).toEqual(
      [byName.id, absorbed.id].sort()
    )
    expect(await idsIn([storeA], `%${tag}@%`, `%${tag}@%`, null)).toEqual([byMail.id])
    expect(await idsIn([storeA], '%zzzz-none%', '%zzzz-none%', '%50377770001%')).toEqual([
      byPhone.id
    ])
    expect(await idsIn([storeB], `%orfeo ${tag}%`, `%orfeo ${tag}%`, null)).toEqual([alien.id])
  })

  it('does not find a customer who was erased, by name, e-mail or phone, and still finds a live one by the same branch', async () => {
    // Its own tag: the e-mails of this case must not match the pattern of the first one
    const erasedTag = `${tag}er`
    const live = await createCustomer(owner, {
      storeId: storeA,
      name: `Viva ${erasedTag}`,
      phone: '+503 7777-0002'
    })
    await owner.customer.update({
      where: { id: live.id },
      data: { email: `live-${erasedTag}@example.invalid` }
    })
    const erased = await createCustomer(owner, {
      storeId: storeA,
      name: `Olvidada ${erasedTag}`,
      phone: '+503 7777-0003'
    })
    await owner.customer.update({
      where: { id: erased.id },
      data: { email: `gone-${erasedTag}@example.invalid`, erasedAt: new Date() }
    })
    const none = '%zzzz-none%'
    // Name, e-mail and phone: each branch finds the live customer and not the erased one
    expect(await idsIn([storeA], `%viva ${erasedTag}%`, none, null)).toEqual([live.id])
    expect(await idsIn([storeA], `%olvidada ${erasedTag}%`, none, null)).toEqual([])
    expect(await idsIn([storeA], none, `%live-${erasedTag}@%`, null)).toEqual([live.id])
    expect(await idsIn([storeA], none, `%gone-${erasedTag}@%`, null)).toEqual([])
    expect(await idsIn([storeA], none, none, '%50377770002%')).toEqual([live.id])
    expect(await idsIn([storeA], none, none, '%50377770003%')).toEqual([])
    // An absorbed customer who was also erased is not found either
    const both = await createCustomer(owner, { storeId: storeA, name: `Fusion ${erasedTag}` })
    await owner.customer.update({
      where: { id: both.id },
      data: { mergedIntoId: live.id, erasedAt: new Date() }
    })
    expect(await idsIn([storeA], `%fusion ${erasedTag}%`, none, null)).toEqual([])
  })

  it('refuses a limit that is missing, zero or past 10001, and a missing name or e-mail pattern', async () => {
    for (const args of [
      ['%a%', '%a%', null, null],
      ['%a%', '%a%', null, 0],
      ['%a%', '%a%', null, 10002],
      [null, '%a%', null, 5],
      ['%a%', null, null, 5]
    ]) {
      await expect(inContext([storeA], async () => appDb.query(CALL, args))).rejects.toThrow()
    }
  })

  it('lets the api and the worker run the function and nobody else', async () => {
    const { rows } = await appDb.query<{ role: string; allowed: boolean }>(
      `SELECT r AS role, has_function_privilege(r,
         'public.rls_search_order_customers(text, text, text, integer)', 'EXECUTE') AS allowed
       FROM unnest(ARRAY['platform_app', 'platform_worker', 'platform_replica_ro', 'public']) AS r`
    )
    expect(Object.fromEntries(rows.map(row => [row.role, row.allowed]))).toEqual({
      platform_app: true,
      platform_worker: true,
      platform_replica_ro: false,
      public: false
    })
  })
})
