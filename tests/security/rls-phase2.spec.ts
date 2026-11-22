import { randomUUID } from 'node:crypto'

import pg from 'pg'

import {
  connectionUrls,
  ensureStore,
  ensureUser,
  type OwnerClient,
  DatabaseRoles
} from '@platform/core/database-testing'
import {
  ChannelIds,
  ConversationStatus,
  MediaStatus,
  OriginKinds,
  MessageType,
  PluginCatalogTypes,
  PluginPricingModels,
  PluginStatus
} from '@platform/core/domain'
import { NotificationSeverity, NotificationTypes } from '@platform/core/notifications'
import { MediaPurpose } from '@platform/core/storage'

import {
  createCustomer,
  createCustomerFiscalData,
  createCustomerIdentity,
  createTag
} from '../builders'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'

// Row-Level Security, phase 2 (migration 20270121200000_rls_phase2_inbox): conversations, messages, customers, the files of a store and
// the channel connections. The policies are DECLARED by the migration and bind nobody until the owner turns enforcement on, so each
// case switches row security on INSIDE one transaction of the owner, runs as platform_app (SET LOCAL ROLE) with the context of the case,
// and ends with ROLLBACK: no other suite of the same database ever sees a table enforced. What is proved is that every table of the
// phase fails closed: no context, no row; the context of store A never reads or writes a row of store B.

const SIDES = ['a', 'b'] as const
type Side = (typeof SIDES)[number]

// The tables of the phase that are seeded here, in the order that locks them (alphabetical, the same in every case: no deadlock)
const TABLES = [
  '_ConversationTags',
  '_CustomerTags',
  'addresses',
  'channel_connections',
  'conversations',
  'customer_identities',
  'customer_notes',
  'customers',
  'media',
  'messages',
  'notifications'
] as const

const COVERED_BY_THE_PHASE = [
  ...TABLES,
  'conversation_origins',
  'customer_fiscal_data',
  'customer_merges',
  'message_reactions',
  'message_revisions'
]

describe('row-level security, phase 2: conversations, customers, files, channel connections', () => {
  const prefix = newRunPrefix()
  const urls = connectionUrls()
  const owner: OwnerClient = ownerClient()
  const raw = new pg.Client({ connectionString: urls.owner })
  const store: Record<Side, string> = { a: '', b: '' }
  const user: Record<Side, string> = { a: '', b: '' }
  // The id of the row of each side, by table (a join table: the pair)
  const row: Record<string, Record<Side, string>> = {}
  const pair: Record<'_ConversationTags' | '_CustomerTags', Record<Side, [string, string]>> = {
    _ConversationTags: { a: ['', ''], b: ['', ''] },
    _CustomerTags: { a: ['', ''], b: ['', ''] }
  }
  const ids: Record<string, Record<string, string>> = {}
  // The second message of each store, the one that the conversation origin points at: `messages` has two rows per store
  const secondMessage: Record<Side, string> = { a: '', b: '' }
  let avatar = ''
  const pluginId = `${prefix}-plugin`

  beforeAll(async () => {
    await raw.connect()
    const org = await owner.organization.create({
      data: { name: `${prefix}-org`, slug: `${prefix}-org` }
    })
    await owner.plugin.create({
      data: {
        id: pluginId,
        name: 'Phase 2 plugin',
        authorName: 'suite',
        authorEmail: 'suite@example.invalid',
        type: PluginCatalogTypes.CHANNEL,
        manifest: {},
        pricingModel: PluginPricingModels.FREE,
        status: PluginStatus.APPROVED,
        organizationId: org.id
      }
    })
    for (const side of SIDES) {
      store[side] = (await ensureStore(owner, org.id, `${prefix}-store-${side}`)).id
      user[side] = (await ensureUser(owner, `${prefix}-${side}@example.invalid`, `User ${side}`)).id
      const installation = await owner.pluginInstallation.create({
        data: {
          storeId: store[side],
          pluginId,
          scopes: [],
          status: 'active',
          installedBy: 'suite'
        }
      })
      const connection = await owner.channelConnection.create({
        data: {
          storeId: store[side],
          pluginId,
          connectionId: `${prefix}-acct-${side}`,
          displayName: `Account ${side}`,
          credentials: Buffer.from('ciphertext-never-readable'),
          installationId: installation.id
        }
      })
      const customer = await createCustomer(owner, { storeId: store[side] })
      const identity = await createCustomerIdentity(owner, {
        storeId: store[side],
        customerId: customer.id,
        channelType: ChannelIds.WEB_WIDGET
      })
      const tag = await createTag(owner, { storeId: store[side] })
      const conversation = await owner.conversation.create({
        data: {
          storeId: store[side],
          customerId: customer.id,
          customerIdentityId: identity.id,
          channelConnectionId: connection.id,
          channelType: ChannelIds.WEB_WIDGET,
          tags: { connect: { id: tag.id } }
        },
        select: { id: true }
      })
      await owner.customer.update({
        where: { id: customer.id },
        data: { tags: { connect: { id: tag.id } } }
      })
      const message = await owner.message.create({
        data: {
          storeId: store[side],
          conversationId: conversation.id,
          type: MessageType.TEXT,
          content: `secret of ${side}`,
          authorType: 'customer'
        },
        select: { id: true }
      })
      const note = await owner.customerNote.create({
        data: { customerId: customer.id, authorId: user[side], content: `note ${side}` },
        select: { id: true }
      })
      const address = await owner.address.create({
        data: { customerId: customer.id, line1: `Street ${side}`, city: 'City' },
        select: { id: true }
      })
      const media = await owner.media.create({
        data: {
          storeId: store[side],
          messageId: message.id,
          purpose: MediaPurpose.MESSAGE,
          key: `${prefix}/message/${side}/${randomUUID()}`,
          filename: 'a.png',
          contentType: 'image/png',
          fileSize: 10,
          status: MediaStatus.CLEAN
        },
        select: { id: true }
      })
      const notification = await owner.notification.create({
        data: {
          userId: user[side],
          storeId: store[side],
          type: NotificationTypes.EXPORT_READY,
          severity: NotificationSeverity.SUCCESS,
          messageKey: 'notifications.suite'
        },
        select: { id: true }
      })
      const second = await owner.message.create({
        data: {
          storeId: store[side],
          conversationId: conversation.id,
          type: MessageType.TEXT,
          content: `origin of ${side}`,
          authorType: 'customer'
        },
        select: { id: true }
      })
      secondMessage[side] = second.id
      const origin = await owner.conversationOrigin.create({
        data: {
          storeId: store[side],
          conversationId: conversation.id,
          messageId: second.id,
          kind: OriginKinds.AD
        },
        select: { id: true }
      })
      const revision = await owner.messageRevision.create({
        data: {
          storeId: store[side],
          messageId: message.id,
          version: 1,
          content: 'before',
          editedByType: 'agent'
        },
        select: { id: true }
      })
      const reaction = await owner.messageReaction.create({
        data: {
          storeId: store[side],
          messageId: message.id,
          authorType: 'customer',
          customerIdentityId: identity.id,
          emoji: '+'
        },
        select: { id: true }
      })
      const merge = await owner.customerMerge.create({
        data: {
          storeId: store[side],
          survivorId: customer.id,
          absorbedId: customer.id,
          snapshot: {},
          mergedById: user[side],
          unmergeUntil: new Date(Date.now() + 86_400_000)
        },
        select: { id: true }
      })
      const fiscal = await createCustomerFiscalData(owner, {
        storeId: store[side],
        customerId: customer.id
      })
      for (const [table, id] of [
        ['addresses', address.id],
        ['channel_connections', connection.id],
        ['conversations', conversation.id],
        ['customer_identities', identity.id],
        ['customer_notes', note.id],
        ['customers', customer.id],
        ['media', media.id],
        ['messages', message.id],
        ['notifications', notification.id],
        ['conversation_origins', origin.id],
        ['message_revisions', revision.id],
        ['message_reactions', reaction.id],
        ['customer_merges', merge.id],
        ['customer_fiscal_data', fiscal.id]
      ] as const) {
        ;(row[table] ??= { a: '', b: '' })[side] = id
      }
      pair._ConversationTags[side] = [conversation.id, tag.id]
      pair._CustomerTags[side] = [customer.id, tag.id]
    }
    // The avatar of the person A: no store, uploaded by the person
    avatar = (
      await owner.media.create({
        data: {
          storeId: null,
          purpose: MediaPurpose.AVATAR,
          uploadedBy: user.a,
          key: `${prefix}/avatar/${randomUUID()}`,
          filename: 'me.png',
          contentType: 'image/png',
          fileSize: 10,
          status: MediaStatus.CLEAN
        },
        select: { id: true }
      })
    ).id
    ids['avatar'] = { id: avatar }
  })

  afterAll(async () => {
    await owner.media.deleteMany({ where: { key: { startsWith: `${prefix}/` } } })
    await cleanUp(owner, prefix)
    await owner.pluginInstallation.deleteMany({ where: { pluginId } })
    await owner.plugin.deleteMany({ where: { id: pluginId } })
    await raw.end().catch(() => undefined)
    await owner.$disconnect()
  })

  // One transaction of the owner: row security on for the tables of the phase, the role of the application, the context, the work,
  // and always ROLLBACK (the ALTER TABLE goes with it)
  async function asApp<T>(
    context: { stores?: string[]; userId?: string },
    work: (query: pg.Client['query']) => Promise<T>
  ): Promise<T> {
    await raw.query('BEGIN')
    try {
      await raw.query("SET LOCAL lock_timeout = '20s'")
      for (const table of [...COVERED_BY_THE_PHASE].sort()) {
        await raw.query(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`)
      }
      await raw.query(`SET LOCAL ROLE ${DatabaseRoles.APP}`)
      await raw.query(
        "SELECT set_config('app.store_ids', $1, true), set_config('app.organization_ids', '', true), set_config('app.user_id', $2, true)",
        [(context.stores ?? []).join(','), context.userId ?? '']
      )
      return await work(raw.query.bind(raw))
    } finally {
      // A broken connection must not hide the error of the case
      await raw.query('ROLLBACK').catch(() => undefined)
    }
  }

  // 42501 is raised both by a policy ("violates row-level security policy") and by a missing GRANT ("permission denied"): only the
  // first one is what these cases look for, and the second is reported as something else so that it cannot pass for it
  const failureCode = async (work: Promise<unknown>): Promise<string | undefined> => {
    try {
      await work
      return undefined
    } catch (error) {
      const { code, message } = error as { code?: string; message?: string }
      if (code === '42501' && !/row-level security/i.test(message ?? '')) {
        return `42501 but not a policy: ${message ?? ''}`
      }
      return code
    }
  }

  const visible = async (query: pg.Client['query'], table: string): Promise<number> => {
    const result = await query<{ n: number }>(`SELECT count(*)::int AS n FROM "${table}"`)
    return result.rows[0]?.n ?? -1
  }

  it('has the policy and the owner policy on every table of the phase', async () => {
    const { rows } = await raw.query<{ table_name: string; policies: string; enabled: boolean }>(
      `SELECT c.relname AS table_name,
              string_agg(p.polname, ',' ORDER BY p.polname) AS policies,
              c.relrowsecurity AS enabled
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
       JOIN pg_policy p ON p.polrelid = c.oid
       WHERE c.relname = ANY ($1::text[])
       GROUP BY c.relname, c.relrowsecurity`,
      [COVERED_BY_THE_PHASE]
    )
    expect(rows.map(r => r.table_name).sort()).toEqual([...COVERED_BY_THE_PHASE].sort())
    for (const r of rows) {
      expect(r.policies).toContain(`${r.table_name}_tenant`)
      expect(r.policies).toContain(`${r.table_name}_owner`)
    }
  })

  it('has seeded a row of each store in every table of the phase (the control of the cases that expect nothing)', async () => {
    for (const [table, sides] of Object.entries(row)) {
      const { rows } = await raw.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "${table}" WHERE id = ANY ($1::text[])`,
        [[sides.a, sides.b]]
      )
      expect([table, rows[0]?.n]).toEqual([table, 2])
    }
    for (const table of ['_ConversationTags', '_CustomerTags'] as const) {
      const { rows } = await raw.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "${table}" WHERE "A" = ANY ($1::text[])`,
        [[pair[table].a[0], pair[table].b[0]]]
      )
      expect([table, rows[0]?.n]).toEqual([table, 2])
    }
  })

  it('shows no row of any table to a transaction with no context', async () => {
    const seen = await asApp({}, async query => {
      const counts: Record<string, number> = {}
      for (const table of COVERED_BY_THE_PHASE) counts[table] = await visible(query, table)
      return counts
    })
    expect(seen).toEqual(Object.fromEntries(COVERED_BY_THE_PHASE.map(table => [table, 0])))
  })

  it('shows the rows of the store of the context and no row of the other, on every table', async () => {
    for (const side of SIDES) {
      const other: Side = side === 'a' ? 'b' : 'a'
      const seen = await asApp({ stores: [store[side]] }, async query => {
        const found: Record<string, string[]> = {}
        for (const table of Object.keys(row)) {
          const { rows } = await query<{ id: string }>(`SELECT id FROM "${table}"`)
          found[table] = rows.map(r => r.id)
        }
        const conversationTags = await query<{ A: string; B: string }>(
          'SELECT "A", "B" FROM "_ConversationTags"'
        )
        const customerTags = await query<{ A: string; B: string }>(
          'SELECT "A", "B" FROM "_CustomerTags"'
        )
        return { found, conversationTags: conversationTags.rows, customerTags: customerTags.rows }
      })
      for (const [table, sides] of Object.entries(row)) {
        // media: the avatar has no store and belongs to a person, not shown to a context that names no person
        const mine = table === 'messages' ? [sides[side], secondMessage[side]] : [sides[side]]
        const theirs = table === 'messages' ? [sides[other], secondMessage[other]] : [sides[other]]
        // Exactly the rows of the store of the context: none missing, none of the other store
        expect([table, [...(seen.found[table] ?? [])].sort()]).toEqual([table, [...mine].sort()])
        for (const id of theirs) expect(seen.found[table]).not.toContain(id)
      }
      expect(seen.conversationTags).toEqual([
        { A: pair._ConversationTags[side][0], B: pair._ConversationTags[side][1] }
      ])
      expect(seen.customerTags).toEqual([
        { A: pair._CustomerTags[side][0], B: pair._CustomerTags[side][1] }
      ])
    }
  })

  it('answers a query by the id of the other store with no row, never an error', async () => {
    const found = await asApp({ stores: [store.a] }, async query => {
      const out: number[] = []
      for (const table of Object.keys(row)) {
        const { rows } = await query(`SELECT id FROM "${table}" WHERE id = $1`, [row[table]?.b])
        out.push(rows.length)
      }
      return out
    })
    expect(found.every(count => count === 0)).toBe(true)
  })

  it('refuses a write that puts a row in the other store, and changes nothing of it', async () => {
    const outcome = await asApp({ stores: [store.a] }, async query => {
      const savepointed = async (
        name: string,
        statement: string,
        values: unknown[]
      ): Promise<string | undefined> => {
        await query(`SAVEPOINT ${name}`)
        const code = await failureCode(query(statement, values))
        await query(`ROLLBACK TO SAVEPOINT ${name}`)
        return code
      }
      const insertNotification = (storeId: string): [string, unknown[]] => [
        'INSERT INTO notifications (id, user_id, store_id, type, severity, message_key) VALUES ($1, $2, $3, $4, $5, $6)',
        [
          randomUUID(),
          user.a,
          storeId,
          NotificationTypes.EXPORT_READY,
          NotificationSeverity.SUCCESS,
          'notifications.suite'
        ]
      ]
      const refused: Record<string, string | undefined> = {}
      refused['customer'] = await savepointed(
        's1',
        'INSERT INTO customers (id, store_id, name, updated_at) VALUES ($1, $2, $3, now())',
        [randomUUID(), store.b, 'x']
      )
      refused['note'] = await savepointed(
        's2',
        'INSERT INTO customer_notes (id, customer_id, author_id, content) VALUES ($1, $2, $3, $4)',
        [randomUUID(), row['customers']?.b, user.a, 'x']
      )
      refused['address'] = await savepointed(
        's3',
        'INSERT INTO addresses (id, customer_id, line1, city) VALUES ($1, $2, $3, $4)',
        [randomUUID(), row['customers']?.b, 'x', 'x']
      )
      refused['notification'] = await savepointed('s4', ...insertNotification(store.b))
      refused['conversationTag'] = await savepointed(
        's5',
        'INSERT INTO "_ConversationTags" ("A", "B") VALUES ($1, $2)',
        [pair._ConversationTags.a[0], pair._ConversationTags.b[1]]
      )
      refused['customerTag'] = await savepointed(
        's6',
        'INSERT INTO "_CustomerTags" ("A", "B") VALUES ($1, $2)',
        [pair._CustomerTags.b[0], pair._CustomerTags.a[1]]
      )
      refused['moveCustomer'] = await savepointed(
        's7',
        'UPDATE customers SET store_id = $1 WHERE id = $2',
        [store.b, row['customers']?.a]
      )
      // The controls: the same statements with the store of the context go through, so a refusal above is the policy and not a
      // wrong statement or a missing grant
      const own = {
        customer: await query(
          'INSERT INTO customers (id, store_id, name, updated_at) VALUES ($1, $2, $3, now())',
          [randomUUID(), store.a, 'x']
        ),
        note: await query(
          'INSERT INTO customer_notes (id, customer_id, author_id, content) VALUES ($1, $2, $3, $4)',
          [randomUUID(), row['customers']?.a, user.a, 'x']
        ),
        address: await query(
          'INSERT INTO addresses (id, customer_id, line1, city) VALUES ($1, $2, $3, $4)',
          [randomUUID(), row['customers']?.a, 'x', 'x']
        ),
        notification: await query(...insertNotification(store.a)),
        update: await query('UPDATE conversations SET status = $1 WHERE id = $2', [
          ConversationStatus.RESOLVED,
          row['conversations']?.a
        ])
      }
      const updated = await query('UPDATE conversations SET status = $1 WHERE id = $2', [
        ConversationStatus.RESOLVED,
        row['conversations']?.b
      ])
      const deleted = await query('DELETE FROM messages WHERE id = $1', [row['messages']?.b])
      // What the other store has now, read as the owner INSIDE the transaction (it is rolled back at the end)
      await query('RESET ROLE')
      const theirs = await query<{ status: string; messages: number }>(
        `SELECT (SELECT status FROM conversations WHERE id = $1) AS status,
                (SELECT count(*)::int FROM messages WHERE id = $2) AS messages`,
        [row['conversations']?.b, row['messages']?.b]
      )
      return {
        refused,
        own: Object.fromEntries(
          Object.entries(own).map(([name, result]) => [name, result.rowCount])
        ),
        updateOfOther: updated.rowCount,
        deleteOfOther: deleted.rowCount,
        theirs: theirs.rows[0]
      }
    })
    expect(outcome.refused).toEqual({
      customer: '42501',
      note: '42501',
      address: '42501',
      notification: '42501',
      conversationTag: '42501',
      customerTag: '42501',
      moveCustomer: '42501'
    })
    expect(outcome.own).toEqual({ customer: 1, note: 1, address: 1, notification: 1, update: 1 })
    expect(outcome.updateOfOther).toBe(0)
    expect(outcome.deleteOfOther).toBe(0)
    expect(outcome.theirs?.status).not.toBe(ConversationStatus.RESOLVED)
    expect(outcome.theirs?.messages).toBe(1)
  })

  describe('media', () => {
    it('shows the avatar of a person to the context of that person only, with or without a store', async () => {
      const own = await asApp({ userId: user.a }, async query =>
        (await query<{ id: string }>('SELECT id FROM media')).rows.map(r => r.id)
      )
      const withStore = await asApp({ stores: [store.a], userId: user.a }, async query =>
        (await query<{ id: string }>('SELECT id FROM media')).rows.map(r => r.id).sort()
      )
      const other = await asApp(
        { userId: user.b },
        async query => (await query<{ id: string }>('SELECT id FROM media')).rows
      )
      const nobody = await asApp({ stores: [store.a] }, async query =>
        (await query<{ id: string }>('SELECT id FROM media')).rows.map(r => r.id)
      )
      expect(own).toEqual([avatar])
      expect(withStore).toEqual([avatar, row['media']?.a].sort())
      expect(other).toEqual([])
      expect(nobody).toEqual([row['media']?.a])
    })

    it('refuses a row with no store that is not the avatar of the person of the context', async () => {
      const codes = await asApp({ stores: [store.a], userId: user.a }, async query => {
        const attempt = async (
          name: string,
          uploadedBy: string | null,
          purpose: string = MediaPurpose.AVATAR
        ): Promise<string | undefined> => {
          await query(`SAVEPOINT ${name}`)
          const code = await failureCode(
            query(
              'INSERT INTO media (id, store_id, purpose, uploaded_by, key, filename, content_type, file_size, status) VALUES ($1, NULL, $4, $2, $3, $5, $6, 1, $7)',
              [
                randomUUID(),
                uploadedBy,
                `${prefix}/avatar/${randomUUID()}`,
                purpose,
                'x',
                'image/png',
                MediaStatus.CLEAN
              ]
            )
          )
          await query(`ROLLBACK TO SAVEPOINT ${name}`)
          return code
        }
        return {
          ofAnother: await attempt('m1', user.b),
          ofNobody: await attempt('m2', null),
          ofMe: await attempt('m3', user.a),
          notAnAvatar: await attempt('m4', user.a, MediaPurpose.MESSAGE)
        }
      })
      expect(codes).toEqual({
        ofAnother: '42501',
        ofNobody: '42501',
        ofMe: undefined,
        notAnAvatar: '42501'
      })
    })

    it('refuses to turn a file of a store into an avatar of the person (no store, same person)', async () => {
      const code = await asApp({ stores: [store.a], userId: user.a }, async query => {
        await query('SAVEPOINT detach')
        const failed = await failureCode(
          query('UPDATE media SET store_id = NULL, uploaded_by = $1 WHERE id = $2', [
            user.a,
            row['media']?.a
          ])
        )
        await query('ROLLBACK TO SAVEPOINT detach')
        return failed
      })
      expect(code).toBe('42501')
    })

    it('does not let a context change or delete the avatar of another person', async () => {
      const result = await asApp({ userId: user.b }, async query => {
        const updated = await query('UPDATE media SET filename = $1 WHERE id = $2', [
          'hacked',
          avatar
        ])
        const deleted = await query('DELETE FROM media WHERE id = $1', [avatar])
        return [updated.rowCount, deleted.rowCount]
      })
      expect(result).toEqual([0, 0])
    })
  })

  it('links a tag to a conversation or a customer of the same store only, even with a context of both stores', async () => {
    const codes = await asApp({ stores: [store.a, store.b] }, async query => {
      const attempt = async (name: string, table: string, a: string, b: string) => {
        await query(`SAVEPOINT ${name}`)
        const code = await failureCode(
          query(`INSERT INTO "${table}" ("A", "B") VALUES ($1, $2)`, [a, b])
        )
        await query(`ROLLBACK TO SAVEPOINT ${name}`)
        return code
      }
      return [
        await attempt(
          't1',
          '_ConversationTags',
          pair._ConversationTags.a[0],
          pair._ConversationTags.b[1]
        ),
        await attempt('t2', '_CustomerTags', pair._CustomerTags.b[0], pair._CustomerTags.a[1])
      ]
    })
    expect(codes).toEqual(['42501', '42501'])
  })

  describe('rls_resolve_channel_connection', () => {
    it('finds the store of a connection with no context, with the ids and the three statuses and nothing else', async () => {
      const answer = await asApp({}, async query =>
        query<Record<string, unknown>>('SELECT * FROM rls_resolve_channel_connection($1, $2)', [
          pluginId,
          `${prefix}-acct-a`
        ])
      )
      expect(answer.rows).toEqual([
        {
          id: row['channel_connections']?.a,
          store_id: store.a,
          status: 'active',
          installation_status: 'active',
          plugin_status: PluginStatus.APPROVED
        }
      ])
      // No credentials, no metadata, no name: the columns are the six that the function declares
      expect(answer.fields.map(field => field.name)).toEqual([
        'id',
        'store_id',
        'status',
        'installation_status',
        'plugin_status'
      ])
      expect(JSON.stringify(answer.rows)).not.toContain('ciphertext')
    })

    it('answers nothing for a connection that does not exist, and the table itself stays closed to the same transaction', async () => {
      const result = await asApp({}, async query => ({
        missing: (
          await query('SELECT * FROM rls_resolve_channel_connection($1, $2)', [pluginId, 'nope'])
        ).rows,
        table: await visible(query, 'channel_connections')
      }))
      expect(result).toEqual({ missing: [], table: 0 })
    })

    it('is a read-only definer with a fixed search_path that the application roles may execute and the public may not', async () => {
      const { rows } = await raw.query<{
        secdef: boolean
        config: string[] | null
        owner: string
        app: boolean
        worker: boolean
        pub: boolean
      }>(
        `SELECT p.prosecdef AS secdef, p.proconfig AS config, pg_get_userbyid(p.proowner) AS owner,
                has_function_privilege('${DatabaseRoles.APP}', p.oid, 'EXECUTE') AS app,
                has_function_privilege('${DatabaseRoles.WORKER}', p.oid, 'EXECUTE') AS worker,
                has_function_privilege('public', p.oid, 'EXECUTE') AS pub
         FROM pg_proc p WHERE p.proname = 'rls_resolve_channel_connection'`
      )
      expect(rows).toHaveLength(1)
      expect(rows[0]?.secdef).toBe(true)
      expect(rows[0]?.config?.join(',')).toContain('search_path')
      expect(rows[0]?.owner).not.toBe(DatabaseRoles.APP)
      expect([rows[0]?.app, rows[0]?.worker, rows[0]?.pub]).toEqual([true, true, false])
    })
  })
})
