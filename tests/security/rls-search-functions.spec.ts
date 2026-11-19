import { getQueueToken } from '@nestjs/bullmq'
import type { INestApplication } from '@nestjs/common'
import pg from 'pg'

import type { OwnerClient } from '@platform/core/database-testing'
import { connectionUrls } from '@platform/core/database-testing'
import {
  ConversationHiddenStatuses,
  MessageType,
  SearchConfig,
  SearchDatabaseErrors
} from '@platform/core/domain'
import { QueueNames } from '@platform/core/queues'

import { createConversationOf, createCustomer, createMessage, createOrder } from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { CapturedQueue } from '../helpers/queue'

// The search functions of migration 20270121600000 (plan B of Row-Level Security): the reads of the search of messages, customers and
// orders. They run as the owner (SECURITY DEFINER) and filter by themselves: the store is the one of the transaction context, so
//  - a call with no store in the context RAISES (never an empty answer that looks like "nothing found");
//  - the context of one store never reads a row of another, with the rows of both in the same tables;
//  - the statement inside the message search reads the GIN index (the reason of the functions: with the policies enforced the planner
//    does not push the text operators below the policy, and the search fell back to the store index). It is measured with volume (two
//    stores of 15000 messages, ANALYZE) from the plan that auto_explain logs for the statement INSIDE the function. The customers and
//    the orders have no such case: the real customer query is an OR of LIKE/ILIKE/%/similarity that the planner reads by the store index
//    even with the policies off (8e, rls-search-plan.spec), so there is no baseline to compare with (plan-notas-76.md).
// The calls are made as platform_app, the role of the api.

const FUNCTION_ARGS = {
  messages: (tag: string) =>
    [
      tag,
      25,
      SearchConfig.MESSAGE_CANDIDATES,
      null,
      true,
      true,
      true,
      true,
      [...ConversationHiddenStatuses],
      MessageType.SYSTEM,
      MessageType.INTERNAL_NOTE,
      MessageType.ORDER_SUMMARY,
      'MaxWords=20, MinWords=5'
    ] as const
}
const MESSAGES_CALL = `SELECT * FROM public.rls_search_messages($1, $2::integer, $3::integer, $4::text, $5::boolean, $6::boolean,
  $7::boolean, $8::boolean, $9::text[], $10, $11, $12, $13)`
const TYPED_CALL = `SELECT * FROM public.rls_search_messages_typed($1, $2, $3::integer, $4::text, $5::boolean, $6::boolean,
  $7::boolean, $8::boolean, $9::text[], $10, $11, $12, $13)`
const CUSTOMERS_CALL = `SELECT * FROM public.rls_search_customers($1, $2, $3, $4, $5, $6::boolean, $7::boolean, $8::integer,
  $9::real, $10::real)`
const CUSTOMER_LIST_CALL = `SELECT * FROM public.rls_search_customer_list($1, $2, $3, $4::boolean, $5, $6, $7::integer)`
const CUSTOMER_COUNT_CALL = `SELECT public.rls_count_customer_list($1, $2, $3) AS n`
const ORDERS_CALL = `SELECT * FROM public.rls_search_orders($1, $2, $3, $4, $5::boolean, $6::boolean, $7::integer)`

describe('the search functions of row-level security', () => {
  const prefix = newRunPrefix()
  const urls = connectionUrls()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let appDb: pg.Client
  const tag = `zs${Math.random()
    .toString(36)
    .slice(2, 10)
    .replaceAll(/[^a-z]/g, 'q')}`

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp([], builder =>
      builder.overrideProvider(getQueueToken(QueueNames.ANALYTICS)).useValue(new CapturedQueue())
    )
    ctx = await seedTestContext(owner, app, prefix)
    appDb = new pg.Client({ connectionString: urls.app })
    await appDb.connect()
  })
  afterAll(async () => {
    await appDb.end()
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  // What the tenant interceptor does: one transaction, the context first, transaction-local
  async function inContext<T>(
    context: { stores: string[]; user?: string },
    work: () => Promise<T>
  ): Promise<T> {
    await appDb.query('BEGIN')
    try {
      await appDb.query(
        `SELECT set_config('app.store_ids', $1, true), set_config('app.organization_ids', '', true),
                set_config('app.user_id', $2, true)`,
        [context.stores.join(','), context.user ?? '']
      )
      const result = await work()
      await appDb.query('COMMIT')
      return result
    } catch (error) {
      await appDb.query('ROLLBACK')
      throw error
    }
  }

  // The arguments of rls_search_messages_typed: the pattern (already folded and escaped), the text, and the four permissions
  const typedArgs = (
    contains: string,
    viewAll: boolean,
    seeHidden: boolean,
    readNotes: boolean,
    readOrders: boolean
  ) =>
    [
      contains,
      'cuando',
      25,
      null,
      viewAll,
      seeHidden,
      readNotes,
      readOrders,
      [...ConversationHiddenStatuses],
      MessageType.SYSTEM,
      MessageType.INTERNAL_NOTE,
      MessageType.ORDER_SUMMARY,
      'MaxWords=20, MinWords=5'
    ] as const

  const messagesIn = (stores: string[], text: string) =>
    inContext({ stores }, async () => {
      const [q, ...rest] = FUNCTION_ARGS.messages(text)
      return (await appDb.query<{ id: string }>(MESSAGES_CALL, [q, ...rest])).rows
    })

  async function seedMessages() {
    const mine = await createConversationOf(owner, { storeId: ctx.storeA.id })
    const theirs = await createConversationOf(owner, { storeId: ctx.storeB.id })
    const own = await createMessage(owner, {
      storeId: ctx.storeA.id,
      conversationId: mine.id,
      content: `Pedido de camión ${tag}`
    })
    const foreign = await createMessage(owner, {
      storeId: ctx.storeB.id,
      conversationId: theirs.id,
      content: `Pedido de camión ${tag}`
    })
    return { own, foreign }
  }

  it('raises when the transaction has no store in its context, for each search', async () => {
    await appDb.query('BEGIN')
    try {
      for (const [call, args] of [
        [MESSAGES_CALL, FUNCTION_ARGS.messages(tag)],
        [TYPED_CALL, typedArgs('%cuando%', true, true, true, true)],
        [CUSTOMERS_CALL, [tag, '%a%', 'a%', '%a%', '%1%', false, false, 5, 0.3, 0.6]],
        [ORDERS_CALL, [tag, '%a%', 'a%', '%1%', true, false, 5]],
        [CUSTOMER_LIST_CALL, [null, '%a%', null, false, null, null, 5]],
        [CUSTOMER_COUNT_CALL, [null, '%a%', null]]
      ] as const) {
        await appDb.query('SAVEPOINT s')
        await expect(appDb.query(call, [...args])).rejects.toThrow(
          SearchDatabaseErrors.CONTEXT_REQUIRED
        )
        await appDb.query('ROLLBACK TO SAVEPOINT s')
      }
    } finally {
      await appDb.query('ROLLBACK')
    }
  })

  it('finds the messages of the store of the context and never those of another store', async () => {
    const { own, foreign } = await seedMessages()
    const asA = (await messagesIn([ctx.storeA.id], tag)).map(row => row.id)
    expect(asA).toContain(own.id)
    expect(asA).not.toContain(foreign.id)
    const asB = (await messagesIn([ctx.storeB.id], tag)).map(row => row.id)
    expect(asB).toContain(foreign.id)
    expect(asB).not.toContain(own.id)
  })

  it('finds the customers and the orders of the store of the context and never those of another store', async () => {
    const customer = await createCustomer(owner, { storeId: ctx.storeA.id, name: `Zoilo ${tag}` })
    const alien = await createCustomer(owner, { storeId: ctx.storeB.id, name: `Zoilo ${tag}` })
    const folded = `zoilo ${tag}`
    const byName = (stores: string[]) =>
      inContext({ stores }, async () =>
        (
          await appDb.query<{ id: string }>(CUSTOMERS_CALL, [
            folded,
            `%${folded}%`,
            `${folded}%`,
            `%${folded}%`,
            '%0%',
            false,
            true,
            25,
            SearchConfig.SIMILARITY_THRESHOLD,
            SearchConfig.WORD_SIMILARITY_THRESHOLD
          ])
        ).rows.map(row => row.id)
      )
    expect(await byName([ctx.storeA.id])).toEqual([customer.id])
    expect(await byName([ctx.storeB.id])).toEqual([alien.id])

    const mine = await createOrder(owner, { storeId: ctx.storeA.id })
    const theirs = await createOrder(owner, { storeId: ctx.storeB.id })
    const number = `S-${tag}-77`
    await owner.order.update({ where: { id: mine.id }, data: { orderNumber: number } })
    await owner.order.update({ where: { id: theirs.id }, data: { orderNumber: number } })
    const byNumber = (stores: string[]) =>
      inContext({ stores }, async () =>
        (
          await appDb.query<{ id: string }>(ORDERS_CALL, [
            number.toLowerCase(),
            `%${number}%`,
            `${number}%`,
            '%0%',
            false,
            false,
            25
          ])
        ).rows.map(row => row.id)
      )
    expect(await byNumber([ctx.storeA.id])).toEqual([mine.id])
    expect(await byNumber([ctx.storeB.id])).toEqual([theirs.id])
  })

  it('lists the customers of a search text from the store of the context only, in the order of the list and of the export', async () => {
    // The moments of creation are exact and apart: two customers made back to back can share a millisecond, and the list is only as
    // ordered as its moments are (ties break by id, which a test cannot predict), so the case does not depend on the clock
    const mine = await createCustomer(owner, {
      storeId: ctx.storeA.id,
      name: `Wanda ${tag}`,
      createdAt: new Date('2026-01-10T10:00:00.000Z')
    })
    const second = await createCustomer(owner, {
      storeId: ctx.storeA.id,
      name: `Wanda ${tag} bis`,
      createdAt: new Date('2026-01-11T10:00:00.000Z')
    })
    const absorbed = await createCustomer(owner, {
      storeId: ctx.storeA.id,
      name: `Wanda ${tag} old`,
      createdAt: new Date('2026-01-12T10:00:00.000Z')
    })
    await owner.customer.update({ where: { id: absorbed.id }, data: { mergedIntoId: mine.id } })
    const alien = await createCustomer(owner, { storeId: ctx.storeB.id, name: `Wanda ${tag}` })
    const pattern = `%wanda ${tag}%`
    const page = (
      stores: string[],
      byId: boolean,
      afterId: string | null,
      limit: number,
      afterAt: Date | null = null
    ) =>
      inContext({ stores }, async () =>
        (
          await appDb.query<{ id: string }>(CUSTOMER_LIST_CALL, [
            pattern,
            pattern,
            null,
            byId,
            afterAt?.toISOString() ?? null,
            afterId,
            limit
          ])
        ).rows.map(row => row.id)
      )
    // Another store never shows, an absorbed customer is left out, and the export order is by id with a keyset
    const byId = await page([ctx.storeA.id], true, null, 25)
    // The order of the export is the order of the database on the id (its collation, not the one of JavaScript): the ids as a set, and
    // the keyset below walks THAT order
    expect([...byId].sort()).toEqual([mine.id, second.id].sort())
    expect(byId).not.toContain(alien.id)
    expect(byId).not.toContain(absorbed.id)
    // That order is exactly `ORDER BY id` of the database (the owner reads it, so a reversed or dropped ORDER BY in the function fails)
    const inDatabaseOrder = await owner.$queryRaw<{ id: string }[]>`
      SELECT id FROM customers WHERE id IN (${mine.id}, ${second.id}) ORDER BY id`
    expect(byId).toEqual(inDatabaseOrder.map(row => row.id))
    expect(await page([ctx.storeA.id], true, byId[0] ?? null, 25)).toEqual(byId.slice(1))
    expect(await page([ctx.storeB.id], true, null, 25)).toEqual([alien.id])
    // The list is newest first
    expect(await page([ctx.storeA.id], false, null, 25)).toEqual([second.id, mine.id])
    // The cursor of the list is a point in (created_at, id): after `second` comes `mine`, and after `mine` nothing; the absorbed one is
    // the newest row on purpose, so a broken merged filter would show first in the list above
    expect(
      await page([ctx.storeA.id], false, second.id, 25, new Date('2026-01-11T10:00:00.000Z'))
    ).toEqual([mine.id])
    expect(
      await page([ctx.storeA.id], false, mine.id, 25, new Date('2026-01-10T10:00:00.000Z'))
    ).toEqual([])
    const count = await inContext({ stores: [ctx.storeA.id] }, async () =>
      appDb.query<{ n: string }>(CUSTOMER_COUNT_CALL, [pattern, pattern, null])
    )
    expect(Number(count.rows[0]?.n)).toBe(2)
  })

  it('refuses a page of the customer list that has no limit, a limit past 1000 or no email pattern', async () => {
    for (const args of [
      [null, '%a%', null, false, null, null, null],
      [null, '%a%', null, false, null, null, 1001],
      [null, null, null, false, null, null, 5]
    ]) {
      await expect(
        inContext({ stores: [ctx.storeA.id] }, async () => appDb.query(CUSTOMER_LIST_CALL, args))
      ).rejects.toThrow()
    }
  })

  it('lets the api and the worker run the customer list functions and nobody else', async () => {
    const { rows } = await appDb.query<{ role: string; allowed: boolean }>(
      `SELECT r AS role, has_function_privilege(r,
         'public.rls_search_customer_list(text, text, text, boolean, text, text, integer)', 'EXECUTE') AS allowed
       FROM unnest(ARRAY['platform_app', 'platform_worker', 'platform_replica_ro', 'public']) AS r`
    )
    expect(Object.fromEntries(rows.map(row => [row.role, row.allowed]))).toEqual({
      platform_app: true,
      platform_worker: true,
      platform_replica_ro: false,
      public: false
    })
  })

  it('reads a text of stop words as typed, with the rules of the search by words, and never from another store', async () => {
    const conversation = await createConversationOf(owner, { storeId: ctx.storeA.id })
    const foreignConversation = await createConversationOf(owner, { storeId: ctx.storeB.id })
    const make = (conversationId: string, storeId: string, content: string, type?: MessageType) =>
      createMessage(owner, { storeId, conversationId, content, ...(type ? { type } : {}) })
    const phrase = `${tag} cuando`
    const own = await make(conversation.id, ctx.storeA.id, phrase)
    const foreign = await make(foreignConversation.id, ctx.storeB.id, phrase)
    const note = await make(conversation.id, ctx.storeA.id, phrase, MessageType.INTERNAL_NOTE)
    const deleted = await make(conversation.id, ctx.storeA.id, phrase)
    await owner.message.update({ where: { id: deleted.id }, data: { deletedAt: new Date() } })
    const discarded = await make(conversation.id, ctx.storeA.id, phrase)
    await owner.message.update({ where: { id: discarded.id }, data: { discardedAt: new Date() } })
    const system = await make(conversation.id, ctx.storeA.id, phrase, MessageType.SYSTEM)
    const typed = (stores: string[], readNotes: boolean) =>
      inContext({ stores }, async () =>
        (
          await appDb.query<{ id: string }>(TYPED_CALL, [
            ...typedArgs(`%${tag} cuando%`, true, true, readNotes, true)
          ])
        ).rows.map(row => row.id)
      )
    const withNotes = await typed([ctx.storeA.id], true)
    expect(withNotes).toEqual(expect.arrayContaining([own.id, note.id]))
    for (const hidden of [foreign.id, deleted.id, discarded.id, system.id]) {
      expect(withNotes).not.toContain(hidden)
    }
    expect(await typed([ctx.storeA.id], false)).not.toContain(note.id)
    expect(await typed([ctx.storeB.id], true)).toEqual([foreign.id])
  })

  it('does not hand the name of the customer to an order search that may not read customers', async () => {
    const order = await createOrder(owner, { storeId: ctx.storeA.id })
    const number = `NC-${tag}-1`
    await owner.order.update({ where: { id: order.id }, data: { orderNumber: number } })
    const row = await owner.order.findUniqueOrThrow({ where: { id: order.id } })
    await owner.customer.update({ where: { id: row.customerId }, data: { name: `Secreto ${tag}` } })
    const names = (byCustomer: boolean) =>
      inContext({ stores: [ctx.storeA.id] }, async () =>
        (
          await appDb.query<{ customer_name: string | null }>(ORDERS_CALL, [
            number.toLowerCase(),
            `%${number}%`,
            `${number}%`,
            '%0%',
            byCustomer,
            false,
            25
          ])
        ).rows.map(hit => hit.customer_name)
      )
    expect(await names(true)).toEqual([`Secreto ${tag}`])
    expect(await names(false)).toEqual([null])
  })

  it('does not let the caller choose the person: the assignment is read from the context', async () => {
    const conversation = await createConversationOf(owner, {
      storeId: ctx.storeA.id,
      assignedTo: ctx.adminA.id
    })
    const message = await createMessage(owner, {
      storeId: ctx.storeA.id,
      conversationId: conversation.id,
      content: `Asignado ${tag}`
    })
    const [q, , candidates, conversationId, , ...rest] = FUNCTION_ARGS.messages(`asignado ${tag}`)
    const idsAs = (user: string | undefined) =>
      inContext({ stores: [ctx.storeA.id], ...(user ? { user } : {}) }, async () =>
        (
          await appDb.query<{ id: string }>(MESSAGES_CALL, [
            q,
            25,
            candidates,
            conversationId,
            false,
            ...rest
          ])
        ).rows.map(row => row.id)
      )
    // Without "see all": the person assigned sees it, another person and an unknown one do not
    expect(await idsAs(ctx.adminA.id)).toContain(message.id)
    expect(await idsAs('someone-else')).not.toContain(message.id)
    expect(await idsAs(undefined)).not.toContain(message.id)
  })
})
