import pg from 'pg'

import { AnalyticsMetrics, ReportFormats, ReportFrequency } from '@platform/core/analytics'
import {
  connectionUrls,
  ensureStore,
  ensureUser,
  type OwnerClient
} from '@platform/core/database-testing'
import {
  CarrierConnectionStatus,
  ChannelConnectionStatus,
  PluginInstallationStatus,
  PluginStatus,
  ShipmentKind,
  ShipmentStatus
} from '@platform/core/domain'
import { NotificationSeverity, NotificationTypes } from '@platform/core/notifications'

import { createCarrierConnection, createMember, createShipment } from '../builders'
import { createChannelConnection } from '../builders/conversation'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'

// The lists of the worker that rls-worker-lists.spec.ts only checks for grants, owner and search path (the pickup lists have their own
// cases there): what each one returns and what it leaves out, read as the role of the worker with NO context, the way its scheduler
// calls it. Debt "each of the other five gets its content case" of PR A, closed here. The suites share the database, so every case
// looks only at the rows this run made. That a plain read with no context sees no row is proved by rls-worker-lists.spec.ts (the pickup
// lists, with row security ON inside a rolled back transaction); the lists here are definers of the same migration.
const PAGE = 2

describe('row-level security, phase 5: what the other lists of the worker return', () => {
  const prefix = newRunPrefix()
  const urls = connectionUrls()
  const owner: OwnerClient = ownerClient()
  const worker = new pg.Client({ connectionString: urls.worker })
  const stores: string[] = []

  beforeAll(async () => {
    await worker.connect()
    const org = await owner.organization.create({
      data: { name: `${prefix}-org`, slug: `${prefix}-org` }
    })
    for (const side of ['a', 'b']) {
      const store = await ensureStore(owner, org.id, `${prefix}-store-${side}`)
      stores.push(store.id)
      // An order (and so a shipment) is written by a member of its store
      await createMember(owner, { storeId: store.id, prefix })
    }
  })

  afterAll(async () => {
    await cleanUp(owner, prefix)
    // The plugins of the channel cases have no store to cascade from: the ids carry the prefix of the run
    await owner.plugin.deleteMany({ where: { id: { startsWith: prefix } } })
    await worker.end().catch(() => undefined)
    await owner.$disconnect()
  })

  const storeA = (): string => stores[0] ?? ''
  const storeB = (): string => stores[1] ?? ''

  // The order the database gives depends on its collation: the cases compare sets, ordered the same way on both sides
  const byId = <Row extends { id: string }>(rows: Row[]): Row[] =>
    [...rows].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))

  const byConnection = <Row extends { connection_id: string }>(rows: Row[]): Row[] =>
    [...rows].sort((x, y) =>
      x.connection_id < y.connection_id ? -1 : x.connection_id > y.connection_id ? 1 : 0
    )

  // Walks a list two rows a page, from just before the first row of this run to the end, so that the cases cross page boundaries (a
  // cursor that repeats or skips a row fails them), and keeps what this run made
  async function walk<Row extends { [key: string]: string }>(
    sql: string,
    args: unknown[],
    key: keyof Row & string,
    mine: ReadonlySet<string>
  ): Promise<Row[]> {
    const ids = [...mine].sort()
    // A prefix is smaller than the text it starts: the first row of this run is still after it
    let after: string | null = (ids[0] ?? '').slice(0, 2)
    const found: Row[] = []
    const seen = new Set<string>()
    for (let guard = 0; guard < 100_000; guard += 1) {
      const page: { rows: Row[] } = await worker.query<Row>(sql, [...args, after, PAGE])
      for (const row of page.rows) {
        const id = row[key] ?? ''
        // A row twice is a cursor that does not move
        expect(`${id}`).not.toBe(after ?? '')
        seen.add(id)
        if (mine.has(id)) found.push(row)
      }
      const tail = page.rows.at(-1)
      if (tail === undefined || page.rows.length < PAGE) break
      after = tail[key] ?? null
    }
    expect(seen.size).toBeGreaterThan(0)
    return found
  }

  it('lists the connections whose benefit is on and active, each with its store, and leaves out the others', async () => {
    const make = async (
      storeId: string,
      benefit: boolean,
      status: CarrierConnectionStatus
    ): Promise<string> => {
      const connection = await createCarrierConnection(owner, { storeId, status })
      await owner.carrierGuidePolicy.create({
        data: {
          connectionId: connection.id,
          storeId,
          benefitEnabled: benefit,
          periodAnchor: '2031-01-01'
        }
      })
      return connection.id
    }
    const onA = await make(storeA(), true, CarrierConnectionStatus.ACTIVE)
    const onB = await make(storeB(), true, CarrierConnectionStatus.ACTIVE)
    const off = await make(storeA(), false, CarrierConnectionStatus.ACTIVE)
    const disabled = await make(storeA(), true, CarrierConnectionStatus.DISABLED)
    const rows = await walk<{ connection_id: string; store_id: string }>(
      'SELECT connection_id, store_id FROM rls_list_benefit_close_targets($1, $2, $3)',
      [CarrierConnectionStatus.ACTIVE],
      'connection_id',
      new Set([onA, onB, off, disabled])
    )
    expect(byConnection(rows)).toEqual(
      byConnection([
        { connection_id: onA, store_id: storeA() },
        { connection_id: onB, store_id: storeB() }
      ])
    )
  })

  it('lists the enabled scheduled reports of every store and no disabled one', async () => {
    const make = async (storeId: string, enabled: boolean): Promise<string> =>
      (
        await owner.scheduledReport.create({
          data: {
            storeId,
            name: `${prefix}-report`,
            metrics: [AnalyticsMetrics.ORDERS_CREATED],
            frequency: ReportFrequency.WEEKLY,
            format: ReportFormats.CSV,
            recipients: ['owner@example.invalid'],
            enabled,
            createdBy: 'suite'
          },
          select: { id: true }
        })
      ).id
    const onA = await make(storeA(), true)
    const onB = await make(storeB(), true)
    const off = await make(storeA(), false)
    const rows = await walk<{ id: string; store_id: string }>(
      'SELECT id, store_id FROM rls_list_enabled_scheduled_reports($1, $2)',
      [],
      'id',
      new Set([onA, onB, off])
    )
    expect(byId(rows)).toEqual(
      byId([
        { id: onA, store_id: storeA() },
        { id: onB, store_id: storeB() }
      ])
    )
  })

  it('lists a person once however many notifications wait for an e-mail, and not one with none waiting', async () => {
    const waiting = await ensureUser(owner, `${prefix}-waiting@example.com`, 'Waiting')
    const quiet = await ensureUser(owner, `${prefix}-quiet@example.com`, 'Quiet')
    const notify = async (userId: string, storeId: string, pending: boolean): Promise<void> => {
      await owner.notification.create({
        data: {
          userId,
          storeId,
          type: NotificationTypes.MESSAGE_FAILED,
          severity: NotificationSeverity.WARNING,
          messageKey: 'notifications.message.failed',
          ...(pending ? { emailPendingAt: new Date() } : {})
        }
      })
    }
    // Two stores, three notifications waiting: one row for the person
    await notify(waiting.id, storeA(), true)
    await notify(waiting.id, storeA(), true)
    await notify(waiting.id, storeB(), true)
    await notify(quiet.id, storeA(), false)
    const rows = await walk<{ user_id: string }>(
      'SELECT user_id FROM rls_list_users_with_pending_email($1, $2)',
      [],
      'user_id',
      new Set([waiting.id, quiet.id])
    )
    expect(rows).toEqual([{ user_id: waiting.id }])
  })

  it('lists the connections of an active installation of an approved plugin that are active or in error, with their store and plugin', async () => {
    const live = await createChannelConnection(owner, {
      storeId: storeA(),
      channelType: `${prefix}-chan`
    })
    const failing = await createChannelConnection(owner, {
      storeId: storeB(),
      channelType: `${prefix}-chan-e`,
      status: ChannelConnectionStatus.ERROR
    })
    const disconnected = await createChannelConnection(owner, {
      storeId: storeB(),
      channelType: `${prefix}-chan-b`,
      status: ChannelConnectionStatus.DISCONNECTED
    })
    const revoked = await createChannelConnection(owner, {
      storeId: storeB(),
      channelType: `${prefix}-chan-c`
    })
    await owner.pluginInstallation.updateMany({
      where: { storeId: storeB(), pluginId: `${prefix}-chan-c` },
      data: { status: PluginInstallationStatus.REVOKED }
    })
    const suspended = await createChannelConnection(owner, {
      storeId: storeA(),
      channelType: `${prefix}-chan-s`
    })
    await owner.plugin.update({
      where: { id: `${prefix}-chan-s` },
      data: { status: PluginStatus.SUSPENDED }
    })
    const rows = await walk<{ id: string; store_id: string; plugin_id: string }>(
      'SELECT id, store_id, plugin_id FROM rls_list_active_channel_connections($1::text[], $2, $3, $4, $5)',
      [
        [ChannelConnectionStatus.ACTIVE, ChannelConnectionStatus.ERROR],
        PluginInstallationStatus.ACTIVE,
        PluginStatus.APPROVED
      ],
      'id',
      new Set([live.id, failing.id, disconnected.id, revoked.id, suspended.id])
    )
    expect(byId(rows)).toEqual(
      byId([
        { id: live.id, store_id: storeA(), plugin_id: `${prefix}-chan` },
        { id: failing.id, store_id: storeB(), plugin_id: `${prefix}-chan-e` }
      ])
    )
  })

  it('lists a connection once for each store with a numbered guide in a polled status, whatever the number of guides', async () => {
    const first = await createShipment(owner, {
      storeId: storeA(),
      status: ShipmentStatus.LABEL_CREATED
    })
    await createShipment(owner, {
      storeId: storeA(),
      status: ShipmentStatus.IN_TRANSIT,
      connectionId: first.connectionId
    })
    const finished = await createShipment(owner, {
      storeId: storeB(),
      status: ShipmentStatus.DELIVERED
    })
    const unnumbered = await createShipment(owner, {
      storeId: storeB(),
      status: ShipmentStatus.LABEL_CREATED
    })
    await owner.shipment.update({ where: { id: unnumbered.id }, data: { guideNumber: null } })
    const disabled = await createShipment(owner, {
      storeId: storeB(),
      status: ShipmentStatus.LABEL_CREATED
    })
    await owner.carrierConnection.update({
      where: { id: disabled.connectionId },
      data: { status: CarrierConnectionStatus.DISABLED }
    })
    const rows = await walk<{ connection_id: string; store_id: string }>(
      'SELECT connection_id, store_id FROM rls_list_shipment_poll_targets($1, $2::text[], $3, $4, $5)',
      [
        ShipmentKind.OUTBOUND,
        [ShipmentStatus.LABEL_CREATED, ShipmentStatus.IN_TRANSIT],
        CarrierConnectionStatus.ACTIVE
      ],
      'connection_id',
      new Set([
        first.connectionId,
        finished.connectionId,
        unnumbered.connectionId,
        disabled.connectionId
      ])
    )
    // One row for the connection with two guides; not the delivered guide, not the one with no number, not the disabled connection
    expect(rows).toEqual([{ connection_id: first.connectionId, store_id: storeA() }])
  })
})
