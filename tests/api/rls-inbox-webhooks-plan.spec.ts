import { randomUUID } from 'node:crypto'

import pg from 'pg'

import { connectionUrls, ensureStore, type OwnerClient } from '@platform/core/database-testing'
import { ChannelIds, ConversationHiddenStatuses, ConversationStatus } from '@platform/core/domain'
import { Events } from '@platform/core/events'

import { createChannelConnection } from '../builders/conversation'
import { createWebhook } from '../builders/webhook'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { retryOnDeadlock } from '../helpers/deadlock-retry'

// The two reads whose plan was never measured with the policies on (debts of 8e and ba): the list of the INBOX (conversations) and the
// log of a webhook (webhook_deliveries, which has no store of its own: its policy asks the parent). The question is not whether the
// planner "likes" an index but whether turning the policy ON changes HOW the table is read: the same index for the same statement,
// and no sort the baseline did not have. If it does, the plan of both travels in the failure and the list needs a definer function
// (as the search did, #730).
//
// The policies are the REAL ones of the migrations: the table is only enabled inside a transaction that is always rolled back, and both
// plans are read as platform_app (not the owner, not a superuser, so the policy applies to it) with the context of ONE store; the
// only difference between the two plans is therefore the policy. Two stores hold the same volume, so the policy has rows to hide.
// The scans that are not index scans are switched off with SET LOCAL so that what the planner CAN use shows, not what the
// statistics make it prefer at this volume.

const ROWS_PER_STORE = 10_000
const CHUNK = 5_000

interface PlanNode {
  'Node Type': string
  'Relation Name'?: string
  'Index Name'?: string
  Plans?: PlanNode[]
}

function walk(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(walk)]
}

// How a plan reads ONE table: the kind of scan and the index, in a stable order. Costs and estimates are not part of it.
function accessPathOf(node: PlanNode, relation: string): string[] {
  return walk(node)
    .filter(n => /Scan$/.test(n['Node Type']) && n['Relation Name'] === relation)
    .map(n => `${n['Node Type']} ${n['Index Name'] ?? ''}`.trim())
    .sort()
}

function sorts(node: PlanNode): number {
  return walk(node).filter(n => /Sort$/.test(n['Node Type'])).length
}

describe('the plan of the inbox and of the delivery log with row-level security on', () => {
  const prefix = newRunPrefix()
  const urls = connectionUrls()
  const owner: OwnerClient = ownerClient()
  const raw = new pg.Client({ connectionString: urls.owner })
  let storeA = ''
  let webhookA = ''
  let agent = ''

  beforeAll(async () => {
    await raw.connect()
    const org = await owner.organization.create({
      data: { name: `${prefix}-org`, slug: `${prefix}-org` }
    })
    agent = randomUUID()
    for (const side of ['a', 'b'] as const) {
      const store = await ensureStore(owner, org.id, `${prefix}-store-${side}`)
      const webhook = await createWebhook(owner, { storeId: store.id })
      if (side === 'a') {
        storeA = store.id
        webhookA = webhook.id
      }
      const customer = await owner.customer.create({
        data: { storeId: store.id, name: `${prefix}-customer-${side}` },
        select: { id: true }
      })
      const identity = await owner.customerIdentity.create({
        data: {
          storeId: store.id,
          customerId: customer.id,
          channelType: ChannelIds.WHATSAPP,
          channelIdentity: `${prefix}-${side}`
        },
        select: { id: true }
      })
      const connection = await createChannelConnection(owner, {
        storeId: store.id,
        channelType: ChannelIds.WHATSAPP
      })
      const now = Date.now()
      for (let from = 0; from < ROWS_PER_STORE; from += CHUNK) {
        await owner.conversation.createMany({
          data: Array.from({ length: CHUNK }, (_, n) => ({
            id: randomUUID(),
            storeId: store.id,
            customerId: customer.id,
            customerIdentityId: identity.id,
            channelConnectionId: connection.id,
            channelType: ChannelIds.WHATSAPP,
            status: n % 7 === 0 ? ConversationStatus.ARCHIVED : ConversationStatus.OPEN,
            assignedTo: n % 5 === 0 ? agent : null,
            lastMessageAt: new Date(now - (from + n) * 60_000)
          }))
        })
        await owner.webhookDelivery.createMany({
          data: Array.from({ length: CHUNK }, (_, n) => ({
            webhookId: webhook.id,
            event: Events.ORDER_CREATED,
            durationMs: 10,
            success: n % 3 !== 0,
            createdAt: new Date(now - (from + n) * 1000)
          }))
        })
      }
    }
    await raw.query('ANALYZE conversations')
    await raw.query('ANALYZE webhook_deliveries')
  }, 180_000)

  afterAll(async () => {
    await cleanUp(owner, prefix)
    await raw.end().catch(() => undefined)
    await owner.$disconnect()
  }, 120_000)

  // The plan of a statement as platform_app with the context of store A, with the real policies of `tables` enabled or not
  const planOf = (
    statement: string,
    values: unknown[],
    tables: string[],
    policiesOn: boolean
  ): Promise<PlanNode> => retryOnDeadlock(() => planOfOnce(statement, values, tables, policiesOn))
  async function planOfOnce(
    statement: string,
    values: unknown[],
    tables: string[],
    policiesOn: boolean
  ): Promise<PlanNode> {
    try {
      await raw.query('BEGIN')
      await raw.query("SET LOCAL lock_timeout = '20s'")
      if (policiesOn) {
        for (const table of tables)
          await raw.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`)
      }
      await raw.query('SET LOCAL enable_seqscan = off')
      await raw.query('SET LOCAL enable_bitmapscan = off')
      await raw.query('SET LOCAL ROLE platform_app')
      await raw.query(
        "SELECT set_config('app.store_ids', $1, true), set_config('app.user_id', $2, true)",
        [storeA, agent]
      )
      const { rows } = await raw.query<{ 'QUERY PLAN': { Plan: PlanNode }[] }>(
        `EXPLAIN (FORMAT JSON) ${statement}`,
        values
      )
      return rows[0]?.['QUERY PLAN'][0]?.Plan ?? { 'Node Type': 'none' }
    } finally {
      await raw.query('ROLLBACK')
    }
  }

  // The inbox page: what ConversationsService.list asks for (the store, the hidden statuses out, what the viewer may see, the order of
  // conversations_store_list_order_idx, a page)
  it('the inbox list reads conversations through the same index, with no extra sort, under the policy', async () => {
    const statement = `SELECT c.id FROM conversations c
        WHERE c.store_id = $1 AND c.status NOT IN (${ConversationHiddenStatuses.map(status => `'${status}'`).join(', ')})
          AND (c.assigned_to IS NULL OR c.assigned_to = $2)
        ORDER BY c.attention_at DESC NULLS LAST, c.last_message_at DESC NULLS LAST, c.id DESC LIMIT 26`
    const values = [storeA, agent]
    const off = await planOf(statement, values, ['conversations'], false)
    const on = await planOf(statement, values, ['conversations'], true)
    const detail = { off: JSON.stringify(off), on: JSON.stringify(on) }
    expect({ ...detail, path: accessPathOf(on, 'conversations') }).toEqual({
      ...detail,
      path: accessPathOf(off, 'conversations')
    })
    expect({ ...detail, sorts: sorts(on) }).toEqual({ ...detail, sorts: sorts(off) })
    expect(accessPathOf(on, 'conversations')).toEqual([
      'Index Scan conversations_store_list_order_idx'
    ])
  })

  // The log of one webhook, newest first (TenantWebhooksService.deliveries). The policy asks the parents (webhooks and
  // plugin_installations), which are enabled too: the sub-selects are part of what is measured.
  it('the delivery log reads webhook_deliveries through the same index under the policy', async () => {
    const statement = `SELECT d.id FROM webhook_deliveries d
        WHERE d.webhook_id = $1 ORDER BY d.created_at DESC, d.id DESC LIMIT 26`
    const tables = ['webhook_deliveries', 'webhooks', 'plugin_installations']
    const off = await planOf(statement, [webhookA], tables, false)
    const on = await planOf(statement, [webhookA], tables, true)
    const detail = { off: JSON.stringify(off), on: JSON.stringify(on) }
    // The NAME of the index of the baseline is not asserted: with the policies off the planner may read this table through the composite
    // index or through the single-column one on created_at (filtering by webhook), depending on the share of the table that webhook A
    // holds, and the table is shared with the specs that run beside this one (the same code chose one in a run and the other in another).
    // What does not depend on the neighbours is what the policy must not change: the table is still read by index scans only (never a
    // sequential or bitmap scan), through one of the two indexes that cover the statement, with no sort the baseline did not have.
    const scansOf = (plan: PlanNode): string[] =>
      accessPathOf(plan, 'webhook_deliveries').map(path =>
        path.replace(/ webhook_deliveries_\w+$/, '')
      )
    expect({ ...detail, kinds: scansOf(on) }).toEqual({ ...detail, kinds: scansOf(off) })
    expect({ ...detail, kinds: scansOf(on) }).toEqual({ ...detail, kinds: ['Index Scan'] })
    expect({ ...detail, sorts: sorts(on) }).toEqual({ ...detail, sorts: sorts(off) })
    // Either index that covers the statement: the choice between them is the planner's, by the statistics of the shared table
    expect({ ...detail, path: accessPathOf(on, 'webhook_deliveries') }).toEqual({
      ...detail,
      path: [
        expect.stringMatching(
          /^Index Scan webhook_deliveries_(webhook_id_created_at_idx|created_at_idx)$/
        )
      ]
    })
  })
})
