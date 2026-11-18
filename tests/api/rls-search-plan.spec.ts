import { randomUUID } from 'node:crypto'

import pg from 'pg'

import {
  connectionUrls,
  ensureStore,
  ensureUser,
  type OwnerClient
} from '@platform/core/database-testing'
import {
  ChannelIds,
  MessageType,
  PluginCatalogTypes,
  PluginPricingModels,
  PluginStatus
} from '@platform/core/domain'

import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'

// The search under Row-Level Security (RLS audit, search section): Postgres evaluates the policy of a table before any condition of
// the query whose operator is not LEAKPROOF, and `@@` of a tsvector, LIKE, ILIKE and the operators of pg_trgm are not. A condition that
// may not run before the policy cannot be an index condition, so the GIN indexes of the search could be left unused the day the
// policies are enforced, and a search would read every message of the store. This suite measures the plan of the two searches that
// matter (the messages and the customers of a store) with the policies ON, as platform_app, in a transaction that is rolled back (the
// ALTER TABLE goes with it, so no other suite sees an enforced table), over enough rows for the index to be the cheaper way.
//
// What it asserts is the plan, not the time: the GIN index of the search is the way in, whatever the machine. A failure here says that
// the search has to go through a read-only SECURITY DEFINER function (the policy is then the explicit `store_id = ANY (context)`
// inside it, and the index serves the search again) before the policies are enforced.

const ROWS_PER_STORE = 15_000
const CHUNK = 5_000

describe('the plan of the searches with row-level security on', () => {
  const prefix = newRunPrefix()
  const urls = connectionUrls()
  const owner: OwnerClient = ownerClient()
  const raw = new pg.Client({ connectionString: urls.owner })
  let storeA = ''
  const pluginId = `${prefix}-plugin`

  beforeAll(async () => {
    await raw.connect()
    const org = await owner.organization.create({
      data: { name: `${prefix}-org`, slug: `${prefix}-org` }
    })
    await owner.plugin.create({
      data: {
        id: pluginId,
        name: 'Plan plugin',
        authorName: 'suite',
        authorEmail: 'suite@example.invalid',
        type: PluginCatalogTypes.CHANNEL,
        manifest: {},
        pricingModel: PluginPricingModels.FREE,
        status: PluginStatus.APPROVED,
        organizationId: org.id
      }
    })
    const author = await ensureUser(owner, `${prefix}-user@example.invalid`, 'Plan user')
    for (const side of ['a', 'b'] as const) {
      const store = await ensureStore(owner, org.id, `${prefix}-store-${side}`)
      if (side === 'a') storeA = store.id
      const installation = await owner.pluginInstallation.create({
        data: { storeId: store.id, pluginId, scopes: [], status: 'active', installedBy: 'suite' }
      })
      const connection = await owner.channelConnection.create({
        data: {
          storeId: store.id,
          pluginId,
          connectionId: `${prefix}-acct-${side}`,
          displayName: side,
          credentials: Buffer.from('x'),
          installationId: installation.id
        }
      })
      const customers = Array.from({ length: ROWS_PER_STORE }, (_, i) => ({
        id: randomUUID(),
        storeId: store.id,
        name:
          i % 5000 === 0
            ? `Zorbalux Quintana ${i}`
            : `Cliente ${i} Perez ${randomUUID().slice(0, 6)}`,
        email: `c${i}-${randomUUID().slice(0, 6)}@example.invalid`
      }))
      for (let at = 0; at < customers.length; at += CHUNK) {
        await owner.customer.createMany({ data: customers.slice(at, at + CHUNK) })
      }
      const identity = await owner.customerIdentity.create({
        data: {
          storeId: store.id,
          customerId: customers[0]?.id ?? '',
          channelType: ChannelIds.WEB_WIDGET,
          channelIdentity: `${prefix}-v-${side}`
        }
      })
      const conversation = await owner.conversation.create({
        data: {
          storeId: store.id,
          customerId: customers[0]?.id ?? '',
          customerIdentityId: identity.id,
          channelConnectionId: connection.id,
          channelType: ChannelIds.WEB_WIDGET
        }
      })
      const messages = Array.from({ length: ROWS_PER_STORE }, (_, i) => ({
        storeId: store.id,
        conversationId: conversation.id,
        type: MessageType.TEXT,
        authorType: 'customer',
        authorId: author.id,
        content:
          i % 5000 === 0
            ? `quiero el zorbalux ahora ${i}`
            : `mensaje numero ${i} sobre pedidos y envios ${randomUUID().slice(0, 8)}`
      }))
      for (let at = 0; at < messages.length; at += CHUNK) {
        await owner.message.createMany({ data: messages.slice(at, at + CHUNK) })
      }
    }
    await raw.query('ANALYZE messages')
    await raw.query('ANALYZE customers')
  }, 120_000)

  afterAll(async () => {
    await cleanUp(owner, prefix)
    await owner.pluginInstallation.deleteMany({ where: { pluginId } })
    await owner.plugin.deleteMany({ where: { id: pluginId } })
    await raw.end().catch(() => undefined)
    await owner.$disconnect()
  }, 120_000)

  // The plan of a statement as platform_app with the context of store A and the policies on; text of the whole plan
  async function planWithPolicies(statement: string, values: unknown[]): Promise<string> {
    await raw.query('BEGIN')
    try {
      await raw.query("SET LOCAL lock_timeout = '20s'")
      for (const table of ['conversations', 'customers', 'messages']) {
        await raw.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`)
      }
      await raw.query('SET LOCAL ROLE platform_app')
      await raw.query("SELECT set_config('app.store_ids', $1, true)", [storeA])
      const { rows } = await raw.query<{ 'QUERY PLAN': unknown }>(
        `EXPLAIN (FORMAT JSON) ${statement}`,
        values
      )
      return JSON.stringify(rows[0]?.['QUERY PLAN'])
    } finally {
      await raw.query('ROLLBACK')
    }
  }

  it('reads the messages of a word through the index of the search, not through every message of the store', async () => {
    const plan = await planWithPolicies(
      `SELECT m.id FROM messages m
       WHERE m.store_id = $1 AND m.deleted_at IS NULL
         AND to_tsvector('spanish'::regconfig, immutable_unaccent(coalesce(m.content, '')))
             @@ websearch_to_tsquery('spanish'::regconfig, immutable_unaccent($2))
       ORDER BY m.created_at DESC, m.id DESC LIMIT 200`,
      [storeA, 'zorbalux']
    )
    expect(plan).toContain('idx_messages_search_unaccent')
  })

  it('reads the customers of a name through the trigram index, not through every customer of the store', async () => {
    const plan = await planWithPolicies(
      `SELECT c.id FROM customers c
       WHERE c.store_id = $1 AND c.erased_at IS NULL AND c.merged_into_id IS NULL
         AND (c.name_search LIKE $2 ESCAPE '\\' OR c.email ILIKE $3 ESCAPE '\\' OR (c.name_search % $4 AND similarity(c.name_search, $4) > 0.3))
       LIMIT 21`,
      [storeA, '%zorbalux%', '%zorbalux%', 'zorbalux']
    )
    expect(plan).toMatch(/idx_customers_(name_search|email)_trgm/)
  })
})
