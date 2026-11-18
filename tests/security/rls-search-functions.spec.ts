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
const VOLUME_ROWS = 15000
const VOLUME_MARKED = 4
const MESSAGES_CALL = `SELECT * FROM public.rls_search_messages($1, $2::integer, $3::integer, $4::text, $5::boolean, $6::boolean,
  $7::boolean, $8::boolean, $9::text[], $10, $11, $12, $13)`
const TYPED_CALL = `SELECT * FROM public.rls_search_messages_typed($1, $2, $3::integer, $4::text, $5::boolean, $6::boolean,
  $7::boolean, $8::boolean, $9::text[], $10, $11, $12, $13)`
const CUSTOMERS_CALL = `SELECT * FROM public.rls_search_customers($1, $2, $3, $4, $5, $6::boolean, $7::boolean, $8::integer,
  $9::real, $10::real)`
const ORDERS_CALL = `SELECT * FROM public.rls_search_orders($1, $2, $3, $4, $5::boolean, $6::boolean, $7::integer)`

describe('the search functions of row-level security', () => {
  const prefix = newRunPrefix()
  const urls = connectionUrls()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let appDb: pg.Client
  let ownerDb: pg.Client
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
    ownerDb = new pg.Client({ connectionString: urls.owner })
    await appDb.connect()
    await ownerDb.connect()
  })
  afterAll(async () => {
    await appDb.end()
    await ownerDb.end()
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
        [ORDERS_CALL, [tag, '%a%', 'a%', '%1%', true, false, 5]]
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

  // Rows of a store that look like the ones of a real inbox, copied from one the builders made (so every NOT NULL column has a valid
  // value) with a new id and a text of their own, one second apart. The generated columns are left out of the column list.
  async function seedVolume(storeId: string, template: string, rows: number, marked: number) {
    const { rows: columns } = await ownerDb.query<{ list: string }>(
      `SELECT string_agg(quote_ident(attname), ',' ORDER BY attnum) AS list FROM pg_attribute
        WHERE attrelid = 'public.messages'::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = ''`
    )
    const list = columns[0]?.list ?? ''
    await ownerDb.query(
      `INSERT INTO public.messages (${list})
       SELECT ${list} FROM (
         SELECT (jsonb_populate_record(NULL::public.messages, to_jsonb(t) || jsonb_build_object(
           'id', gen_random_uuid()::text,
           'content', CASE WHEN g <= $3 THEN $4 || ' pedido de camión ' || g ELSE 'relleno número ' || g || ' del almacén' END,
           'created_at', t.created_at - g * interval '1 second',
           'channel_message_id', NULL, 'idempotency_key', NULL))).*
         FROM public.messages t CROSS JOIN generate_series(1, $2::integer) g
         WHERE t.id = $1
       ) x`,
      [template, rows, marked, tag]
    )
    await ownerDb.query('ANALYZE public.messages')
    return storeId
  }

  // The plan of the statements INSIDE a function, as auto_explain logs them (the outer plan only says "Function Scan"). Run on the
  // connection of the owner of the database, which can load it; the plan of a SECURITY DEFINER function does not depend on who calls.
  async function planOf(store: string, call: string, args: readonly unknown[]): Promise<string> {
    const plans: string[] = []
    const collect = (notice: { message?: string }) => plans.push(notice.message ?? '')
    ownerDb.on('notice', collect)
    try {
      await ownerDb.query('BEGIN')
      await ownerDb.query(
        `SELECT set_config('app.store_ids', $1, true), set_config('app.organization_ids', '', true)`,
        [store]
      )
      await ownerDb.query(`LOAD 'auto_explain'`)
      await ownerDb.query('SET LOCAL auto_explain.log_min_duration = 0')
      await ownerDb.query('SET LOCAL auto_explain.log_nested_statements = on')
      await ownerDb.query('SET LOCAL client_min_messages = log')
      await ownerDb.query(call, [...args])
      await ownerDb.query('COMMIT')
    } catch (error) {
      await ownerDb.query('ROLLBACK')
      throw error
    } finally {
      ownerDb.off('notice', collect)
    }
    return plans.join('\n')
  }

  it('reads the full-text index of the messages with the rows of two stores in the table, and not the store index', async () => {
    const mine = await createConversationOf(owner, { storeId: ctx.storeA.id })
    const theirs = await createConversationOf(owner, { storeId: ctx.storeB.id })
    const first = await createMessage(owner, {
      storeId: ctx.storeA.id,
      conversationId: mine.id,
      content: 'semilla'
    })
    const second = await createMessage(owner, {
      storeId: ctx.storeB.id,
      conversationId: theirs.id,
      content: 'semilla'
    })
    await seedVolume(ctx.storeA.id, first.id, VOLUME_ROWS, VOLUME_MARKED)
    await seedVolume(ctx.storeB.id, second.id, VOLUME_ROWS, VOLUME_MARKED)

    const [q, ...rest] = FUNCTION_ARGS.messages(`camion ${tag}`)
    const plan = await planOf(ctx.storeA.id, MESSAGES_CALL, [q, ...rest])
    // The message of the plan is what failed, so it travels with the assertion
    expect({ usesGin: plan.includes('idx_messages_search_unaccent'), plan }).toMatchObject({
      usesGin: true
    })
    expect(plan).not.toMatch(/Seq Scan on messages/)
    // And it answers: the marked rows of the store of the context, and none of the other store
    const ids = (await messagesIn([ctx.storeA.id], `camion ${tag}`)).map(row => row.id)
    expect(ids.length).toBe(VOLUME_MARKED)
    const alien = await ownerDb.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM public.messages WHERE id = ANY($1::text[]) AND store_id <> $2',
      [ids, ctx.storeA.id]
    )
    expect(alien.rows[0]?.n).toBe('0')
  })
})
