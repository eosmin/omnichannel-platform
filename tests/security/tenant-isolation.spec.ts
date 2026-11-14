import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ChannelOAuthConfig } from '@platform/channels/connections'
import { AnalyticsMetrics, MetricDimensions, ReportFrequency } from '@platform/core/analytics'
import { ApiRoutes } from '@platform/core/api'
import { Permissions, RoleNames, TenantHeaders } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  CarrierId,
  ChannelIds,
  CountStatus,
  ConversationStatus,
  DeliveryStatus,
  InvitationStatus,
  MembershipStatus,
  MessageType,
  OrderMessageKind,
  OrderMessageNotSentReasons,
  OrderMessageRoutes,
  OrderMessageTriggers,
  PaymentMethod,
  RemittanceStatus,
  RoutingActionTypes,
  PickupStatus,
  ShipmentStatus,
  ShippingPlugin,
  TransferStatus
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { Locales } from '@platform/core/i18n'
import {
  NotificationSeverity,
  notificationMessageKey,
  NotificationTypes
} from '@platform/core/notifications'
import { ExportFormats, ExportTypes } from '@platform/core/queues'
import { StorageKeys } from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'
import { PluginRegistry } from '@platform/plugins/runtime'

import { ChannelOAuthStore } from '../../apps/api/src/modules/channels/oauth/channel-oauth.store'
import {
  buildChannelPlugin,
  createCustomer,
  createCustomerIdentity,
  createCustomerMerge,
  createAllocationOf,
  createReturn,
  createReturnLineOf,
  returnOfLine,
  createLevelOf,
  createMovementOf,
  createOrder,
  orderOfAllocation,
  createProduct,
  createProductVariant,
  itemOfStockRow,
  createTransfer,
  createWarehouse,
  linkWarehouse,
  BUILT_SERVICE_CODE,
  createCarrierConnection,
  createRemittance,
  createRemittanceImportProfile,
  createPickup,
  createShipment,
  createChannelConnection,
  createInvitation,
  createMember,
  createBusinessHours,
  conversationOfMessage,
  conversationOfOrigin,
  createConversationOf,
  createConversationOriginOf,
  createDiscardableReplyOf,
  createMessage,
  createMessageOf,
  createMessageReactionOf,
  createMessageRevisionOf,
  messageOfReaction,
  messageOfRevision,
  createRole,
  createRoutingRule,
  ensurePluginInstallation,
  createOrderMessageTemplate,
  createSnippet,
  createApiKey,
  createWebhook,
  createTag,
  resetStoreSettings,
  customerOfIdentity,
  survivorOfMerge
} from '../builders'
import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { anonymousApi, api, apiWithoutStore } from '../helpers/http'
import {
  type IsolationCheck,
  isolationChecks,
  type IsolationResource,
  type IsolationScene
} from '../helpers/isolation'

// The release gate of the platform (TDD_13 section 6): no user, in no way, reaches the data of a
// store they do not belong to. It runs against the real app, as the api runs: the same AppModule,
// the same guards, and the database role platform_app.
//
// EVERY resource that belongs to a store is described here (a name, how to write one, where to read
// and change it). scripts/check-isolation-coverage.ts compares this list with the models of the
// schema that carry a store_id and fails the build for a model that is neither here nor exempt,
// with the reason and the step that will build it, in scripts/isolation-exemptions.ts.
const prefix = newRunPrefix()
// Set once the context exists: the role a member is moved to in the modification check
// The organization a store belongs to: the warehouses are the organization's, and the suite names a store
async function organizationOfStore(owner: OwnerClient, storeId: string): Promise<string> {
  return (
    await owner.store.findUniqueOrThrow({
      where: { id: storeId },
      select: { organizationId: true }
    })
  ).organizationId
}

let viewerRoleId = ''
// Two warehouses of organization A, for the body of the creation check of the transfers
let transferWarehouses = { from: '', to: '' }
// The stores of the suite, in the order of the shares of kinds the templates take (store A, its sibling, store B)
let templateStores: string[] = []
let agentRoleId = ''
// A user for the reactions the suite writes as the owner
let reactorId = ''
// The batch that holds each reception item the suite makes: the routes of an item name its batch
const batchOfReceptionItem = new Map<string, string>()
// A conversation of store A, where the creation check writes its messages
let conversationInA = ''
// A row the suite changes must have been made by createMessageOf: otherwise the check would be
// aimed at a conversation chosen at random and pass for the wrong reason
const conversationOf = (messageId: string): string => {
  const found = conversationOfMessage.get(messageId)
  if (found === undefined)
    throw new Error(`the message ${messageId} was not made by createMessageOf`)
  return found
}

// The sheet a count resource of the suite is made of: a warehouse of the organization of the store, one item of the store
// with a snapshot of 5, and a sheet in the status given
const countOfLine = new Map<string, string>()
// The connection a service of the suite belongs to: a service is reached through its connection
const connectionOfRow = new Map<string, string>()
// The kind and language of each template row the suite made. A store takes pairs of its own (kinds named here, two languages),
// so that a row of one never answers a request of another by sharing its address: only the filter by the store keeps them apart.
// Pairs are never reused: a store that runs out of them fails loudly, instead of an old id pointing at a replaced row.
const templateOfRow = new Map<string, { kind: string; locale: string }>()
const TEMPLATE_KINDS_OF_STORE_A = [
  OrderMessageKind.ORDER_SHIPPED,
  OrderMessageKind.ORDER_OUT_FOR_DELIVERY,
  OrderMessageKind.ORDER_DELIVERED
]
const TEMPLATE_KINDS_OF_SIBLING = [OrderMessageKind.ORDER_CANCELLED, OrderMessageKind.ORDER_SUMMARY]
const TEMPLATE_KINDS_OF_STORE_B = [
  OrderMessageKind.ORDER_FAILED_ATTEMPT,
  OrderMessageKind.RETURN_APPROVED,
  OrderMessageKind.EXCHANGE_SHIPPED
]
const templateTurns = new Map<string, number>()
const templateAddress = (id: string): string => {
  // An id the suite did not make (the one of the "does not exist" check) asks for a pair that only store B of the suite holds
  const pair = templateOfRow.get(id) ?? {
    kind: TEMPLATE_KINDS_OF_STORE_B[2] ?? OrderMessageKind.EXCHANGE_SHIPPED,
    locale: Locales.EN
  }
  return ApiRoutes.orderTemplates.byKindAndLocale(pair.kind, pair.locale)
}
async function createTemplateOfSuite(owner: OwnerClient, storeId: string): Promise<{ id: string }> {
  const kinds = [TEMPLATE_KINDS_OF_STORE_A, TEMPLATE_KINDS_OF_SIBLING, TEMPLATE_KINDS_OF_STORE_B][
    Math.max(0, templateStores.indexOf(storeId))
  ]
  const pairs = (kinds ?? []).flatMap(kind =>
    [Locales.ES, Locales.EN].map(locale => ({ kind: String(kind), locale: String(locale) }))
  )
  const turn = templateTurns.get(storeId) ?? 0
  const pair = pairs[turn]
  if (pair === undefined) {
    throw new Error('the store ran out of pairs of kind and language for the template case')
  }
  templateTurns.set(storeId, turn + 1)
  const row = await createOrderMessageTemplate(owner, { storeId, ...pair })
  templateOfRow.set(row.id, pair)
  return { id: row.id }
}

// The shipment each history row of the cases belongs to: the history is changed through its shipment
const shipmentOfEvent = new Map<string, string>()
// The remittance each line of the cases belongs to: a line is changed through its remittance
const remittanceOfLine = new Map<string, string>()
// The order each record of a message about an order belongs to: it is reached through the route that sends one
const orderOfDispatch = new Map<string, string>()
// Counts the numbers of the sheets the suite writes: unique inside an organization with no luck involved
let countSerial = 100_000_000 + (process.pid % 1_000_000) * 100
async function createCountOf(
  owner: OwnerClient,
  storeId: string,
  status: CountStatus
): Promise<{ countId: string; lineId: string }> {
  const organizationId = await organizationOfStore(owner, storeId)
  const warehouse = await createWarehouse(owner, { organizationId })
  await linkWarehouse(owner, { organizationId, storeId, warehouseId: warehouse.id })
  const product = await createProduct(owner, { storeId })
  const count = await owner.stockCount.create({
    data: {
      organizationId,
      warehouseId: warehouse.id,
      // Digits only, as the CHECK of the table asks, and one for each sheet of the run
      number: `CT-${(countSerial += 1)}`,
      status,
      startedAt: status === CountStatus.COUNTING ? new Date() : null,
      createdBy: await adminOf(owner, storeId)
    },
    select: { id: true }
  })
  const line = await owner.stockCountLine.create({
    data: { countId: count.id, storeId, productId: product.id, expectedQuantity: 5 },
    select: { id: true }
  })
  return { countId: count.id, lineId: line.id }
}

const PREFERENCE_TYPE = NotificationTypes.CONVERSATION_ASSIGNED
const adminOf = async (owner: OwnerClient, storeId: string): Promise<string> =>
  (
    await owner.membership.findFirstOrThrow({
      where: { storeId, role: { name: RoleNames.ADMIN } },
      select: { userId: true }
    })
  ).userId
const setPreferencePush = async (
  owner: OwnerClient,
  storeId: string,
  push: boolean
): Promise<void> => {
  const userId = await adminOf(owner, storeId)
  await owner.notificationPreference.upsert({
    where: { userId_storeId_type: { userId, storeId, type: PREFERENCE_TYPE } },
    create: {
      userId,
      storeId,
      type: PREFERENCE_TYPE,
      inApp: true,
      push,
      email: false,
      sound: true
    },
    update: { push }
  })
}

// The series of a metric of each granularity, over a range that holds the rows below
const METRIC_RANGE = 'from=2026-01-01T00:00:00.000Z&to=2026-01-02T00:00:00.000Z'
const METRIC_QUERY = {
  hourly: `metric=${AnalyticsMetrics.CHANNEL_VOLUME}&dimension=${MetricDimensions.CHANNEL}&granularity=hour&${METRIC_RANGE}`,
  daily: `metric=${AnalyticsMetrics.CHANNEL_VOLUME}&dimension=${MetricDimensions.CHANNEL}&granularity=day&${METRIC_RANGE}`
}

// One row of the metric in the store, with the marker as its dimension id: the rows of the store are replaced, so a store
// holds one marker at a time
async function writeMetricMarker(
  owner: OwnerClient,
  table: 'hourly' | 'daily',
  storeId: string,
  marker: string
): Promise<void> {
  const row = {
    storeId,
    metric: AnalyticsMetrics.CHANNEL_VOLUME,
    dimension: MetricDimensions.CHANNEL,
    dimensionId: marker,
    value: 1,
    count: 1
  }
  if (table === 'hourly') {
    await owner.metricHourly.deleteMany({ where: { storeId } })
    await owner.metricHourly.create({
      data: { ...row, hour: new Date('2026-01-01T00:00:00.000Z') }
    })
    return
  }
  await owner.metricDaily.deleteMany({ where: { storeId } })
  await owner.metricDaily.create({ data: { ...row, date: new Date('2026-01-01') } })
}

function metricMarkerIn(body: unknown): string | null {
  const series = (body as { series?: { dimensionId: string }[] }).series ?? []
  return series.length === 1 ? (series[0]?.dimensionId ?? null) : null
}

const resources: IsolationResource[] = [
  {
    name: 'customer',
    create: createCustomer,
    readPath: ApiRoutes.customers.byId,
    listPath: ApiRoutes.customers.list,
    modify: { path: ApiRoutes.customers.byId, body: { name: 'hacked' } },
    untouched: async (owner, id) =>
      (await owner.customer.findUnique({ where: { id }, select: { name: true } }))?.name !==
      'hacked',
    creation: {
      path: ApiRoutes.customers.list,
      body: name => ({ name }),
      strict: true,
      countIn: (owner, storeId) => owner.customer.count({ where: { storeId } }),
      storeOf: async (owner, id) =>
        (await owner.customer.findUnique({ where: { id }, select: { storeId: true } }))?.storeId ??
        null
    }
  },
  {
    name: 'customerIdentity',
    create: createCustomerIdentity,
    // An identity is reached through its customer: the route that removes it
    modify: {
      path: id => ApiRoutes.customers.identityById(customerOfIdentity.get(id) ?? '', id),
      method: 'delete',
      body: {}
    },
    untouched: async (owner, id) =>
      (await owner.customerIdentity.findUnique({ where: { id }, select: { id: true } })) !== null
  },
  {
    name: 'customerMerge',
    create: createCustomerMerge,
    // A merge is reached through the unmerge of its survivor
    modify: {
      path: id => ApiRoutes.customers.unmerge(survivorOfMerge.get(id) ?? ''),
      method: 'post',
      body: id => ({ mergeId: id })
    },
    untouched: async (owner, id) =>
      (await owner.customerMerge.findUnique({ where: { id }, select: { unmergedAt: true } }))
        ?.unmergedAt === null
  },
  {
    name: 'channelConnection',
    create: (owner, input) =>
      createChannelConnection(owner, { storeId: input.storeId, channelType: 'test_channel' }),
    readPath: ApiRoutes.channels.connectionById,
    listPath: ApiRoutes.channels.connections,
    modify: { path: ApiRoutes.channels.disconnect, method: 'post', body: {} },
    untouched: async (owner, id) =>
      (await owner.channelConnection.findUnique({ where: { id }, select: { status: true } }))
        ?.status === 'active'
  },
  // The carrier connections of a store (Step 4.8, PR B2). The services and the guide numbering of a connection have no
  // route of their own: they are read and changed through the connection, so the checks reach them by the route of the
  // connection they belong to, and the row must be as it was after a refused change.
  {
    name: 'carrierConnection',
    create: async (owner, input) => createCarrierConnection(owner, { storeId: input.storeId }),
    readPath: ApiRoutes.carriers.byId,
    listPath: ApiRoutes.carriers.list,
    modify: { path: ApiRoutes.carriers.byId, body: { displayName: 'hacked' } },
    untouched: async (owner, id) =>
      (await owner.carrierConnection.findUnique({ where: { id }, select: { displayName: true } }))
        ?.displayName !== 'hacked',
    creation: {
      path: ApiRoutes.carriers.create,
      body: name => ({
        carrierId: CarrierId.LOCAL,
        credentials: { name, phone: '70000000', prefix: 'ISO' }
      }),
      strict: true,
      countIn: (owner, storeId) => owner.carrierConnection.count({ where: { storeId } }),
      storeOf: async (owner, id) =>
        (await owner.carrierConnection.findUnique({ where: { id }, select: { storeId: true } }))
          ?.storeId ?? null
    }
  },
  // The templates of the messages of an order (Step 4.9, PR C1). A template is addressed by its kind and language, not by an
  // id, so the suite keeps which pair each row it makes has. The stores of the suite take kinds of their own, so that a row of
  // one never answers a request of another by sharing its address: only the filter by the store keeps them apart. The route
  // writes by address (a PUT of the own store makes a row of its own), so the change a stranger tries is the deletion.
  {
    name: 'orderMessageTemplate',
    create: async (owner, input) => {
      const row = await createTemplateOfSuite(owner, input.storeId)
      return { id: row.id }
    },
    readPath: id => templateAddress(id),
    listPath: ApiRoutes.orderTemplates.list,
    modify: { path: id => templateAddress(id), method: 'delete', body: {} },
    untouched: async (owner, id) =>
      (await owner.orderMessageTemplate.findUnique({ where: { id }, select: { id: true } })) !==
      null
  },
  {
    name: 'carrierService',
    create: async (owner, input) => {
      const built = await createCarrierConnection(owner, { storeId: input.storeId })
      connectionOfRow.set(built.serviceId, built.id)
      return { id: built.serviceId }
    },
    modify: {
      path: id => ApiRoutes.carriers.byId(connectionOfRow.get(id) ?? randomUUID()),
      body: { services: [{ code: BUILT_SERVICE_CODE, label: 'hacked', active: false }] }
    },
    untouched: async (owner, id) => {
      const row = await owner.carrierService.findUnique({ where: { id } })
      return row !== null && row.label !== 'hacked' && row.active
    }
  },
  {
    name: 'guideSequence',
    create: async (owner, input) => {
      const built = await createCarrierConnection(owner, { storeId: input.storeId })
      // The sequence is identified by its connection
      return { id: built.id }
    },
    modify: {
      path: ApiRoutes.carriers.byId,
      body: { credentials: { name: 'x', phone: '70000000', prefix: 'HACK' } }
    },
    untouched: async (owner, id) =>
      (await owner.guideSequence.findUnique({ where: { connectionId: id } }))?.prefix === 'T'
  },
  // What a carrier's codes mean for a connection (Step 4.8, PR C2a): a row is reached through the connection it belongs to.
  // The mappings are read by the list of the connection and changed by the route of their code; the codes waiting for the
  // owner are read by their own list, and a change that tried to map one would resolve it.
  {
    name: 'carrierStatusMapping',
    create: async (owner, input) => {
      const built = await createCarrierConnection(owner, { storeId: input.storeId })
      const row = await owner.carrierStatusMapping.create({
        data: {
          storeId: input.storeId,
          connectionId: built.id,
          providerCode: 'delivered',
          label: 'Delivered',
          status: ShipmentStatus.DELIVERED
        },
        select: { id: true }
      })
      connectionOfRow.set(row.id, built.id)
      return row
    },
    readPath: id => ApiRoutes.carriers.statusMappings(connectionOfRow.get(id) ?? randomUUID()),
    modify: {
      path: id =>
        ApiRoutes.carriers.statusMappingByCode(
          connectionOfRow.get(id) ?? randomUUID(),
          'delivered'
        ),
      method: 'put',
      body: { status: ShipmentStatus.RETURNED }
    },
    untouched: async (owner, id) =>
      (await owner.carrierStatusMapping.findUnique({ where: { id }, select: { status: true } }))
        ?.status === ShipmentStatus.DELIVERED
  },
  {
    name: 'carrierUnmappedStatus',
    create: async (owner, input) => {
      const built = await createCarrierConnection(owner, { storeId: input.storeId })
      const row = await owner.carrierUnmappedStatus.create({
        data: {
          storeId: input.storeId,
          connectionId: built.id,
          providerCode: 'zzz',
          sampleRawStatus: 'Zzz'
        },
        select: { id: true }
      })
      connectionOfRow.set(row.id, built.id)
      return row
    },
    readPath: id => ApiRoutes.carriers.unmappedStatuses(connectionOfRow.get(id) ?? randomUUID()),
    modify: {
      path: id =>
        ApiRoutes.carriers.statusMappingByCode(connectionOfRow.get(id) ?? randomUUID(), 'zzz'),
      method: 'put',
      body: { status: ShipmentStatus.DELIVERED }
    },
    untouched: async (owner, id) =>
      (
        await owner.carrierUnmappedStatus.findUnique({
          where: { id },
          select: { resolvedAt: true }
        })
      )?.resolvedAt === null
  },
  // The guides of a store (Step 4.8, PR C1). The history of a shipment has no route of its own: it is read inside the
  // shipment, so the checks reach it by the route of the shipment it belongs to.
  {
    name: 'shipment',
    create: async (owner, input) => {
      const built = await createShipment(owner, { storeId: input.storeId })
      return { id: built.id }
    },
    readPath: ApiRoutes.shipments.byId,
    listPath: ApiRoutes.shipments.list,
    modify: {
      path: ApiRoutes.shipments.status,
      method: 'post',
      body: { status: ShipmentStatus.PICKED_UP }
    },
    untouched: async (owner, id) =>
      (await owner.shipment.findUnique({ where: { id }, select: { status: true } }))?.status ===
      ShipmentStatus.LABEL_CREATED
  },
  {
    name: 'shipmentEvent',
    create: async (owner, input) => {
      const built = await createShipment(owner, { storeId: input.storeId })
      shipmentOfEvent.set(built.eventId, built.id)
      return { id: built.eventId }
    },
    modify: {
      path: id => ApiRoutes.shipments.status(shipmentOfEvent.get(id) ?? randomUUID()),
      method: 'post',
      body: { status: ShipmentStatus.PICKED_UP }
    },
    untouched: async (owner, id) => {
      const event = await owner.shipmentEvent.findUnique({ where: { id } })
      if (event === null) return false
      return (await owner.shipmentEvent.count({ where: { shipmentId: event.shipmentId } })) === 1
    }
  },
  // The pickups of a store (Step 4.11). A pickup of another store is a 404 on every route, the list of the other store never
  // holds it, and a confirm from outside leaves it as it was. Making one from a connection of another store is covered by
  // tests/api/pickups.spec.ts (it needs a waiting guide of that connection).
  {
    name: 'pickupRequest',
    create: async (owner, input) => {
      const built = await createPickup(owner, { storeId: input.storeId })
      return { id: built.id }
    },
    readPath: ApiRoutes.pickups.manifest,
    listPath: ApiRoutes.pickups.list,
    modify: { path: ApiRoutes.pickups.confirm, method: 'post', body: {} },
    untouched: async (owner, id) =>
      (await owner.pickupRequest.findUnique({ where: { id }, select: { status: true } }))
        ?.status === PickupStatus.MANUAL_REQUIRED
  },
  // The metrics of a store (Step 5.2): rows that nobody reads by id, only the series of the store of the request. Each store has
  // its own marker, in the dimension id of the row, and the request of a store gets the marker of that store and never another.
  {
    name: 'metricHourly',
    create: async (owner, input) => {
      await writeMetricMarker(owner, 'hourly', input.storeId, 'unset')
      return { id: input.storeId }
    },
    readPath: () => `${ApiRoutes.analytics.metrics}?${METRIC_QUERY.hourly}`,
    own: {
      set: (owner, storeId, marker) => writeMetricMarker(owner, 'hourly', storeId, marker),
      markerIn: metricMarkerIn
    },
    untouched: async (owner, id) => (await owner.metricHourly.count({ where: { storeId: id } })) > 0
  },
  {
    name: 'metricDaily',
    create: async (owner, input) => {
      await writeMetricMarker(owner, 'daily', input.storeId, 'unset')
      return { id: input.storeId }
    },
    readPath: () => `${ApiRoutes.analytics.metrics}?${METRIC_QUERY.daily}`,
    own: {
      set: (owner, storeId, marker) => writeMetricMarker(owner, 'daily', storeId, marker),
      markerIn: metricMarkerIn
    },
    untouched: async (owner, id) => (await owner.metricDaily.count({ where: { storeId: id } })) > 0
  },
  // The scheduled reports of a store (Step 5.2 PR C). A report of another store is a 404 to change or delete, the list of the other
  // store never holds it, and a creation that names another store in the body is refused. The export of the analytics reads
  // the rollups of the store of the request: that is the case of the metrics above, and tests/api/analytics-reports.spec.ts reads a
  // file of a store with the rows of another next to it.
  {
    name: 'scheduledReport',
    create: async (owner, input) =>
      owner.scheduledReport.create({
        data: {
          storeId: input.storeId,
          name: 'isolation-original',
          metrics: [AnalyticsMetrics.ORDERS_CREATED],
          frequency: ReportFrequency.WEEKLY,
          format: 'csv',
          recipients: ['isolation@example.com'],
          createdBy: randomUUID()
        },
        select: { id: true }
      }),
    listPath: ApiRoutes.analytics.reports,
    modify: { path: ApiRoutes.analytics.reportById, body: { name: 'hacked' } },
    untouched: async (owner, id) =>
      (await owner.scheduledReport.findUnique({ where: { id }, select: { name: true } }))?.name ===
      'isolation-original',
    creation: {
      path: ApiRoutes.analytics.reports,
      body: name => ({
        name,
        metrics: [AnalyticsMetrics.ORDERS_CREATED],
        frequency: ReportFrequency.WEEKLY,
        format: 'csv',
        recipients: ['isolation@example.com'],
        timezone: 'America/El_Salvador'
      }),
      strict: true,
      countIn: (owner, storeId) => owner.scheduledReport.count({ where: { storeId } }),
      storeOf: async (owner, id) =>
        (await owner.scheduledReport.findUnique({ where: { id }, select: { storeId: true } }))
          ?.storeId ?? null
    }
  },
  {
    name: 'orderMessageDispatch',
    create: async (owner, input) => {
      const order = await createOrder(owner, { storeId: input.storeId })
      const row = await owner.orderMessageDispatch.create({
        data: {
          storeId: input.storeId,
          orderId: order.id,
          kind: OrderMessageKind.ORDER_SUMMARY,
          trigger: OrderMessageTriggers.MANUAL,
          route: OrderMessageRoutes.NOT_SENT,
          reason: OrderMessageNotSentReasons.NO_TEMPLATE,
          idempotencyKey: `isolation:${randomUUID()}`
        },
        select: { id: true }
      })
      orderOfDispatch.set(row.id, order.id)
      return { id: row.id }
    },
    // Sending a message of an order of another store is a 404 that writes nothing: no record, no message, no email
    modify: {
      path: id => ApiRoutes.orders.messages(orderOfDispatch.get(id) ?? randomUUID()),
      method: 'post',
      body: { kind: OrderMessageKind.ORDER_SUMMARY, idempotencyKey: `isolation-${randomUUID()}` }
    },
    untouched: async (owner, id) => {
      const row = await owner.orderMessageDispatch.findUnique({ where: { id } })
      if (row === null) return false
      return (await owner.orderMessageDispatch.count({ where: { orderId: row.orderId } })) === 1
    }
  },
  // A bulk run of labels (Step 4.10, PR D1): read by its id, started by the bulk route (which takes the store of the header and
  // refuses a body that names another). No route changes it: the worker is the only one that writes its progress.
  {
    name: 'bulkLabelJob',
    create: async (owner, input) => {
      const orderIds = [randomUUID()]
      return owner.bulkLabelJob.create({
        data: {
          storeId: input.storeId,
          orderIds,
          total: orderIds.length,
          requestedBy: await adminOf(owner, input.storeId)
        },
        select: { id: true }
      })
    },
    readPath: ApiRoutes.shipments.bulkJob,
    untouched: async (owner, id) => (await owner.bulkLabelJob.count({ where: { id } })) === 1,
    creation: {
      path: ApiRoutes.shipments.bulk,
      body: () => ({ orderIds: [randomUUID()] }),
      strict: true,
      // The run is queued for the worker: accepted, not created
      status: 202,
      countIn: (owner, storeId) => owner.bulkLabelJob.count({ where: { storeId } }),
      storeOf: async (owner, id) =>
        (await owner.bulkLabelJob.findUnique({ where: { id }, select: { storeId: true } }))
          ?.storeId ?? null
    }
  },
  // The settlements of the cash collected on delivery (Step 4.13): read by id and listed, confirmed by its route. A line has no
  // route to read it: it is read inside its remittance and changed through it.
  {
    name: 'codRemittance',
    create: async (owner, input) => {
      const connection = await createCarrierConnection(owner, { storeId: input.storeId })
      return createRemittance(owner, { storeId: input.storeId, connectionId: connection.id })
    },
    readPath: ApiRoutes.remittances.byId,
    listPath: ApiRoutes.remittances.list,
    modify: { path: ApiRoutes.remittances.confirm, method: 'post', body: {} },
    untouched: async (owner, id) =>
      (await owner.codRemittance.findUnique({ where: { id }, select: { status: true } }))
        ?.status === RemittanceStatus.DRAFT
  },
  {
    name: 'codRemittanceLine',
    create: async (owner, input) => {
      const connection = await createCarrierConnection(owner, { storeId: input.storeId })
      const built = await createRemittance(owner, {
        storeId: input.storeId,
        connectionId: connection.id,
        withLine: true
      })
      const lineId = built.lineId ?? ''
      remittanceOfLine.set(lineId, built.id)
      return { id: lineId }
    },
    modify: {
      path: id => ApiRoutes.remittances.lineById(remittanceOfLine.get(id) ?? randomUUID(), id),
      method: 'patch',
      body: { excluded: true }
    },
    untouched: async (owner, id) =>
      (await owner.codRemittanceLine.findUnique({ where: { id }, select: { excluded: true } }))
        ?.excluded === false
  },
  // How a carrier's settlement file is read (Step 4.13, PR C): listed by the store of the request and renamed by its id. It has no
  // route that reads one profile: the list is what the screen draws.
  {
    name: 'remittanceImportProfile',
    create: async (owner, input) => {
      const connection = await createCarrierConnection(owner, { storeId: input.storeId })
      return createRemittanceImportProfile(owner, {
        storeId: input.storeId,
        connectionId: connection.id
      })
    },
    listPath: ApiRoutes.remittances.importProfiles,
    modify: {
      path: ApiRoutes.remittances.importProfileById,
      method: 'patch',
      body: { name: 'Taken over' }
    },
    untouched: async (owner, id) =>
      (await owner.remittanceImportProfile.findUnique({ where: { id }, select: { name: true } }))
        ?.name !== 'Taken over'
  },
  // Uninstalling is the one change a user can make; the installation is reached by its id
  {
    name: 'pluginInstallation',
    create: (owner, input) =>
      ensurePluginInstallation(owner, { storeId: input.storeId, pluginId: 'test_channel' }),
    modify: { path: ApiRoutes.plugins.revoke, method: 'post', body: {} },
    untouched: async (owner, id) =>
      (await owner.pluginInstallation.findUnique({ where: { id }, select: { status: true } }))
        ?.status === 'active'
  },
  {
    name: 'tag',
    create: createTag,
    readPath: ApiRoutes.settings.tagById,
    listPath: ApiRoutes.settings.tags,
    modify: { path: ApiRoutes.settings.tagById, body: { name: 'hacked' } },
    untouched: async (owner, id) =>
      (await owner.tag.findUnique({ where: { id }, select: { name: true } }))?.name !== 'hacked',
    creation: {
      path: ApiRoutes.settings.tags,
      body: name => ({ name }),
      strict: true,
      countIn: (owner, storeId) => owner.tag.count({ where: { storeId } }),
      storeOf: async (owner, id) =>
        (await owner.tag.findUnique({ where: { id }, select: { storeId: true } }))?.storeId ?? null
    }
  },
  {
    name: 'product',
    create: createProduct,
    readPath: ApiRoutes.products.byId,
    listPath: ApiRoutes.products.list,
    modify: { path: ApiRoutes.products.byId, body: { name: 'hacked' } },
    untouched: async (owner, id) =>
      (await owner.product.findUnique({ where: { id }, select: { name: true } }))?.name !==
      'hacked',
    creation: {
      path: ApiRoutes.products.create,
      body: name => ({ name, priceCents: 1000 }),
      strict: true,
      countIn: (owner, storeId) => owner.product.count({ where: { storeId } }),
      storeOf: async (owner, id) =>
        (await owner.product.findUnique({ where: { id }, select: { storeId: true } }))?.storeId ??
        null
    }
  },
  // Stock has no route by its own id: it is read through the item (the product, and the kardex of the item in a
  // warehouse), so the reads below name the item the row belongs to. Writing stock is the adjustment route, checked in
  // `describe('inventory')` below, and the engine itself in tests/api/inventory-engine.spec.ts.
  {
    name: 'inventoryLevel',
    create: createLevelOf,
    readPath: id => ApiRoutes.products.inventory(itemOfStockRow.get(id)?.productId ?? randomUUID()),
    listPath: ApiRoutes.inventory.levels,
    untouched: () => Promise.resolve(true)
  },
  {
    name: 'inventoryMovement',
    create: createMovementOf,
    readPath: id => {
      const item = itemOfStockRow.get(id)
      return `${ApiRoutes.inventory.kardex}?productId=${item?.productId ?? randomUUID()}&warehouseId=${item?.warehouseId ?? randomUUID()}`
    },
    listPath: ApiRoutes.inventory.movements,
    untouched: () => Promise.resolve(true)
  },
  // An order has its own routes; its allocations are read with it, and written only with it (OrdersService), so the
  // reads below name the order the allocation belongs to. The rest of the rules of orders is in `describe('orders')` below
  {
    name: 'order',
    create: createOrder,
    readPath: ApiRoutes.orders.byId,
    listPath: ApiRoutes.orders.list,
    modify: { path: ApiRoutes.orders.byId, body: { customerNotes: 'hacked' } },
    untouched: async (owner, id) =>
      (await owner.order.findUnique({ where: { id }, select: { customerNotes: true } }))
        ?.customerNotes !== 'hacked'
  },
  {
    name: 'orderItemAllocation',
    create: createAllocationOf,
    // An id the builder did not make (the check asks for a random one to compare the answers) reads an order that does not exist
    readPath: id => ApiRoutes.orders.byId(orderOfAllocation.get(id) ?? randomUUID()),
    untouched: async (owner, id) => (await owner.orderItemAllocation.count({ where: { id } })) === 1
  },
  // A return has its own routes; its lines are read with it, and written only with it (ReturnsService). Every change of a
  // return is a POST on its own id, checked in `describe('returns')` below
  {
    name: 'orderReturn',
    create: async (owner, input) => ({ id: (await createReturn(owner, input)).id }),
    readPath: ApiRoutes.returns.byId,
    listPath: ApiRoutes.returns.list,
    untouched: async (owner, id) =>
      (await owner.orderReturn.findUnique({ where: { id }, select: { status: true } }))?.status ===
      'requested'
  },
  {
    name: 'orderReturnLine',
    create: createReturnLineOf,
    // An id the builder did not make (the check asks for a random one to compare the answers) reads a return that does not exist
    readPath: id => ApiRoutes.returns.byId(returnOfLine.get(id) ?? randomUUID()),
    untouched: async (owner, id) => (await owner.orderReturnLine.count({ where: { id } })) === 1
  },
  // The reception by scanner: a batch and its packages are read, changed and completed only through the store of the request
  {
    name: 'returnReceptionBatch',
    create: async (owner, { storeId }) => ({
      id: (
        await owner.returnReceptionBatch.create({
          data: { storeId, createdBy: 'system' },
          select: { id: true }
        })
      ).id
    }),
    readPath: ApiRoutes.returns.reception.batchById,
    listPath: ApiRoutes.returns.reception.batches,
    modify: { path: ApiRoutes.returns.reception.complete, method: 'post', body: {} },
    untouched: async (owner, id) =>
      (await owner.returnReceptionBatch.findUnique({ where: { id }, select: { status: true } }))
        ?.status === 'draft'
  },
  {
    name: 'returnReceptionItem',
    create: async (owner, { storeId }) => {
      const shipment = await createShipment(owner, {
        storeId,
        status: ShipmentStatus.RETURNING
      })
      const batch = await owner.returnReceptionBatch.create({
        data: { storeId, createdBy: 'system' },
        select: { id: true }
      })
      const item = await owner.returnReceptionItem.create({
        data: { storeId, batchId: batch.id, shipmentId: shipment.id, reason: 'DELIVERY_FAILED' },
        select: { id: true }
      })
      batchOfReceptionItem.set(item.id, batch.id)
      return { id: item.id }
    },
    // An id the builder did not make (the check asks for a random one to compare the answers) reads a batch that does not exist
    readPath: id =>
      ApiRoutes.returns.reception.batchById(batchOfReceptionItem.get(id) ?? randomUUID()),
    modify: {
      path: id =>
        ApiRoutes.returns.reception.itemById(batchOfReceptionItem.get(id) ?? randomUUID(), id),
      body: { note: 'hacked' }
    },
    untouched: async (owner, id) =>
      (await owner.returnReceptionItem.findUnique({ where: { id }, select: { note: true } }))
        ?.note === null
  },
  {
    name: 'warehouse',
    create: async (owner, { storeId }) => ({
      id: (
        await createWarehouse(owner, {
          organizationId: await organizationOfStore(owner, storeId)
        })
      ).id
    }),
    // The organization's: every store of it sees it (TDD_16 §1), a member of another organization never does
    scope: 'organization',
    readPath: ApiRoutes.warehouses.byId,
    listPath: ApiRoutes.warehouses.list,
    modify: { path: ApiRoutes.warehouses.byId, body: { name: 'hacked' } },
    untouched: async (owner, id) =>
      (await owner.warehouse.findUnique({ where: { id }, select: { name: true } }))?.name !==
      'hacked',
    creation: {
      path: ApiRoutes.warehouses.create,
      body: name => ({ name, code: `W${randomUUID().slice(0, 8)}` }),
      strict: true,
      countIn: async (owner, storeId) =>
        owner.warehouse.count({
          where: { organizationId: await organizationOfStore(owner, storeId) }
        }),
      storeOf: async (owner, id) =>
        (await owner.warehouse.findUnique({ where: { id }, select: { organizationId: true } }))
          ?.organizationId ?? null
    }
  },
  {
    name: 'storeWarehouse',
    create: async (owner, { storeId }) => {
      // A link of a store to a warehouse has no route of its own: its row is the warehouse it belongs to, which is
      // read with the warehouse and changed by replacing the links of the warehouse
      const organizationId = await organizationOfStore(owner, storeId)
      const warehouse = await createWarehouse(owner, { organizationId })
      await linkWarehouse(owner, { organizationId, storeId, warehouseId: warehouse.id })
      return { id: warehouse.id }
    },
    scope: 'organization',
    readPath: ApiRoutes.warehouses.byId,
    modify: { path: ApiRoutes.warehouses.stores, method: 'put', body: { stores: [] } },
    untouched: async (owner, id) =>
      (await owner.storeWarehouse.count({ where: { warehouseId: id } })) === 1
  },
  // A count belongs to the organization (TDD_16 §1, §6): every store of it reaches the sheet, another organization none
  {
    name: 'stockCount',
    create: async (owner, { storeId }) => ({
      id: (await createCountOf(owner, storeId, CountStatus.DRAFT)).countId
    }),
    scope: 'organization',
    readPath: ApiRoutes.counts.byId,
    listPath: ApiRoutes.counts.list,
    modify: { path: ApiRoutes.counts.cancel, method: 'post', body: {} },
    untouched: async (owner, id) =>
      (await owner.stockCount.findUnique({ where: { id }, select: { status: true } }))?.status ===
      CountStatus.DRAFT
  },
  // The lines belong to the store of their product: they are read and entered through the count, and a person reaches
  // only those of the stores they belong to. The count of the row is open, so that what refuses the request is the
  // store of the line and not the state of the sheet.
  {
    name: 'stockCountLine',
    create: async (owner, { storeId }) => {
      const { countId, lineId } = await createCountOf(owner, storeId, CountStatus.COUNTING)
      countOfLine.set(lineId, countId)
      return { id: lineId }
    },
    modify: {
      path: id => ApiRoutes.counts.lines(countOfLine.get(id) ?? randomUUID()),
      body: id => ({ lines: [{ lineId: id, countedQuantity: 7 }] })
    },
    untouched: async (owner, id) =>
      (await owner.stockCountLine.findUnique({ where: { id }, select: { countedQuantity: true } }))
        ?.countedQuantity === null
  },
  {
    name: 'stockTransfer',
    create: async (owner, { storeId }) => ({
      id: (
        await createTransfer(owner, { organizationId: await organizationOfStore(owner, storeId) })
      ).id
    }),
    // The header belongs to the organization (TDD_16 §1): every store of it sees it, another organization never does
    scope: 'organization',
    readPath: ApiRoutes.transfers.byId,
    listPath: ApiRoutes.transfers.list,
    modify: { path: ApiRoutes.transfers.byId, body: { note: 'hacked' } },
    untouched: async (owner, id) =>
      (await owner.stockTransfer.findUnique({ where: { id }, select: { note: true } }))?.note !==
      'hacked',
    creation: {
      path: ApiRoutes.transfers.create,
      body: () => ({
        fromWarehouseId: transferWarehouses.from,
        toWarehouseId: transferWarehouses.to
      }),
      strict: true,
      countIn: async (owner, storeId) =>
        owner.stockTransfer.count({
          where: { organizationId: await organizationOfStore(owner, storeId) }
        }),
      storeOf: async (owner, id) =>
        (await owner.stockTransfer.findUnique({ where: { id }, select: { organizationId: true } }))
          ?.organizationId ?? null
    }
  },
  // A line has no route of its own: it is read with its transfer, and only by the members of ITS store (the cases
  // of the block of the transfers below prove the rest)
  {
    name: 'stockTransferLine',
    create: async (owner, { storeId }) => ({
      id: (
        await createTransfer(owner, {
          organizationId: await organizationOfStore(owner, storeId),
          storeId
        })
      ).id
    }),
    // A store's: a member of a sibling store of the organization gets the same answer as a stranger
    readPath: ApiRoutes.transfers.byId,
    modify: { path: ApiRoutes.transfers.byId, body: { note: 'hacked' } },
    untouched: async (owner, id) =>
      (await owner.stockTransfer.findUnique({ where: { id }, select: { note: true } }))?.note !==
      'hacked'
  },
  {
    name: 'snippet',
    create: createSnippet,
    readPath: ApiRoutes.settings.snippetById,
    listPath: ApiRoutes.settings.snippets,
    modify: { path: ApiRoutes.settings.snippetById, body: { title: 'hacked' } },
    untouched: async (owner, id) =>
      (await owner.snippet.findUnique({ where: { id }, select: { title: true } }))?.title !==
      'hacked',
    creation: {
      path: ApiRoutes.settings.snippets,
      body: name => ({ shortcut: name, title: name, content: name }),
      strict: true,
      countIn: (owner, storeId) => owner.snippet.count({ where: { storeId } }),
      storeOf: async (owner, id) =>
        (await owner.snippet.findUnique({ where: { id }, select: { storeId: true } }))?.storeId ??
        null
    }
  },
  // Step 5.4 PR A: the outbound webhooks of a store (their delivery log has no store of its own and is read through
  // the webhook, under the store of the request: the cases of tests/api/tenant-webhooks.spec.ts prove it)
  {
    name: 'webhook',
    create: createWebhook,
    readPath: ApiRoutes.settings.webhookById,
    listPath: ApiRoutes.settings.webhooks,
    modify: { path: ApiRoutes.settings.webhookById, body: { status: 'paused' } },
    untouched: async (owner, id) =>
      (await owner.webhook.findUnique({ where: { id }, select: { status: true } }))?.status ===
      'active',
    creation: {
      path: ApiRoutes.settings.webhooks,
      body: () => ({ url: 'https://8.8.8.8/hook', events: ['order.created'] }),
      strict: true,
      countIn: (owner, storeId) => owner.webhook.count({ where: { storeId } }),
      storeOf: async (owner, id) =>
        (await owner.webhook.findUnique({ where: { id }, select: { storeId: true } }))?.storeId ??
        null
    }
  },
  // Step 5.4 PR A: the API keys of a store. No route reads one by its id (the list is the read); the route that
  // revokes one is the one a stranger would try, and the key must stay active.
  {
    name: 'apiKey',
    create: createApiKey,
    listPath: ApiRoutes.settings.apiKeys,
    modify: { path: ApiRoutes.settings.apiKeyById, method: 'delete', body: {} },
    untouched: async (owner, id) =>
      (await owner.apiKey.findUnique({ where: { id }, select: { status: true } }))?.status ===
      'active',
    creation: {
      path: ApiRoutes.settings.apiKeys,
      body: name => ({ name, scopes: ['customers:view'] }),
      strict: true,
      countIn: (owner, storeId) => owner.apiKey.count({ where: { storeId } }),
      storeOf: async (owner, id) =>
        (await owner.apiKey.findUnique({ where: { id }, select: { storeId: true } }))?.storeId ??
        null
    }
  },
  // One row per store: the id is the store, and the route has none
  {
    name: 'businessHours',
    create: createBusinessHours,
    own: {
      set: async (owner, storeId, marker) => {
        await owner.businessHours.update({
          where: { storeId },
          data: { timezone: marker === 'A' ? 'America/Costa_Rica' : 'Asia/Tokyo' }
        })
      },
      markerIn: body => {
        const timezone = (body as { timezone?: string }).timezone
        return timezone === 'America/Costa_Rica' ? 'A' : timezone === 'Asia/Tokyo' ? 'B' : null
      }
    },
    readPath: () => ApiRoutes.settings.businessHours,
    modify: {
      path: () => ApiRoutes.settings.businessHours,
      method: 'put',
      body: {
        timezone: 'UTC',
        schedule: { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] },
        awayMessageSnippetId: null
      }
    },
    untouched: async (owner, id) =>
      (await owner.businessHours.findUnique({ where: { storeId: id }, select: { timezone: true } }))
        ?.timezone !== 'UTC'
  },
  {
    name: 'storeSettings',
    create: resetStoreSettings,
    own: {
      set: async (owner, storeId, marker) => {
        await owner.storeSettings.update({
          where: { storeId },
          data: { agentLoadThreshold: marker === 'A' ? 11 : 22 }
        })
      },
      markerIn: body => {
        const threshold = (body as { agentLoadThreshold?: number }).agentLoadThreshold
        return threshold === 11 ? 'A' : threshold === 22 ? 'B' : null
      }
    },
    readPath: () => ApiRoutes.settings.inbox,
    modify: { path: () => ApiRoutes.settings.inbox, body: { reopenWindowDays: 99 } },
    untouched: async (owner, id) =>
      (
        await owner.storeSettings.findUnique({
          where: { storeId: id },
          select: { reopenWindowDays: true }
        })
      )?.reopenWindowDays !== 99
  },
  {
    // The same row as above, read and changed through its preferences (one key of the Json column)
    name: 'storePreferences',
    create: resetStoreSettings,
    own: {
      set: async (owner, storeId, marker) => {
        await owner.storeSettings.update({
          where: { storeId },
          data: { preferences: { sendReadReceipts: marker === 'A' } }
        })
      },
      markerIn: body => {
        const receipts = (body as { sendReadReceipts?: boolean }).sendReadReceipts
        return receipts === true ? 'A' : receipts === false ? 'B' : null
      }
    },
    readPath: () => ApiRoutes.settings.preferences,
    modify: {
      path: () => ApiRoutes.settings.preferences,
      method: 'put',
      body: { sendReadReceipts: false }
    },
    // The factory state is an empty column: a change would have written the key
    untouched: async (owner, id) =>
      JSON.stringify(
        (
          await owner.storeSettings.findUnique({
            where: { storeId: id },
            select: { preferences: true }
          })
        )?.preferences
      ) === '{}'
  },
  {
    // The orders block of the same column (the create-order checkboxes and the cancellation reasons)
    name: 'storeOrderPreferences',
    create: resetStoreSettings,
    own: {
      set: async (owner, storeId, marker) => {
        await owner.storeSettings.update({
          where: { storeId },
          // Neither marker is a factory default, so a read of an empty column is never taken for a store's own
          data: {
            preferences: {
              orders: marker === 'A' ? { confirmOnCreate: true } : { sendSummaryOnCreate: false }
            }
          }
        })
      },
      markerIn: body => {
        const orders = (
          body as { orders?: { confirmOnCreate?: boolean; sendSummaryOnCreate?: boolean } }
        ).orders
        return orders?.confirmOnCreate === true
          ? 'A'
          : orders?.sendSummaryOnCreate === false
            ? 'B'
            : null
      }
    },
    readPath: () => ApiRoutes.settings.preferences,
    modify: {
      path: () => ApiRoutes.settings.preferences,
      method: 'put',
      body: {
        orders: {
          confirmOnCreate: true,
          cancellationReasons: [{ id: 'other-store', label: 'Written by someone else' }]
        }
      }
    },
    // The factory state is an empty column: a change would have written the block
    untouched: async (owner, id) =>
      JSON.stringify(
        (
          await owner.storeSettings.findUnique({
            where: { storeId: id },
            select: { preferences: true }
          })
        )?.preferences
      ) === '{}'
  },
  {
    name: 'conversation',
    create: createConversationOf,
    readPath: ApiRoutes.conversations.byId,
    listPath: ApiRoutes.conversations.list,
    modify: {
      path: ApiRoutes.conversations.status,
      body: { status: ConversationStatus.PENDING }
    },
    untouched: async (owner, id) =>
      (await owner.conversation.findUnique({ where: { id }, select: { status: true } }))?.status ===
      ConversationStatus.OPEN
  },
  {
    name: 'message',
    create: createMessageOf,
    // A message is reached through its conversation: the thread that holds it, and the reply to it
    // The check that asks for a message that exists nowhere gets a conversation that exists nowhere
    readPath: id => ApiRoutes.conversations.messages(conversationOfMessage.get(id) ?? randomUUID()),
    modify: {
      path: () => ApiRoutes.messages.create,
      method: 'post',
      body: id => ({
        type: MessageType.TEXT,
        conversationId: conversationOf(id),
        content: 'hacked',
        idempotencyKey: randomUUID()
      })
    },
    // Still the one message it was created with
    untouched: async (owner, id) => {
      const conversationId = conversationOfMessage.get(id)
      return (
        conversationId !== undefined &&
        (await owner.message.count({ where: { conversationId } })) === 1
      )
    },
    creation: {
      path: ApiRoutes.messages.create,
      body: name => ({
        type: MessageType.TEXT,
        conversationId: conversationInA,
        content: name,
        idempotencyKey: randomUUID()
      }),
      strict: true,
      countIn: (owner, storeId) => owner.message.count({ where: { storeId } }),
      storeOf: async (owner, id) =>
        (await owner.message.findUnique({ where: { id }, select: { storeId: true } }))?.storeId ??
        null
    }
  },
  {
    name: 'messageReaction',
    create: (owner, { storeId }) => createMessageReactionOf(owner, { storeId, userId: reactorId }),
    // Reactions are read inside the thread of their conversation; the one that is changed is reached
    // through its message
    readPath: id => ApiRoutes.conversations.messages(conversationOfMessage.get(id) ?? randomUUID()),
    modify: {
      path: id => ApiRoutes.messages.reaction(messageOfReaction.get(id) ?? randomUUID()),
      method: 'put',
      body: { emoji: '🔥' }
    },
    // Still the thumbs up it was created with, and not waiting to be sent
    untouched: async (owner, id) => {
      const row = await owner.messageReaction.findUnique({
        where: { id },
        select: { emoji: true, deliveryStatus: true }
      })
      return row?.emoji === '👍' && row.deliveryStatus === DeliveryStatus.SENT.valueOf()
    }
  },
  {
    name: 'conversationOrigin',
    create: createConversationOriginOf,
    // An origin is read through its conversation; the one thing a stranger could try to change is the
    // conversation it hangs from
    readPath: id => ApiRoutes.conversations.origins(conversationOfOrigin.get(id) ?? randomUUID()),
    modify: {
      path: id => ApiRoutes.conversations.status(conversationOfOrigin.get(id) ?? randomUUID()),
      body: { status: ConversationStatus.PENDING }
    },
    untouched: async (owner, id) => {
      const origin = await owner.conversationOrigin.findUnique({
        where: { id },
        select: { conversation: { select: { status: true } } }
      })
      return origin?.conversation.status === ConversationStatus.OPEN.valueOf()
    }
  },
  {
    // The same model, for the route that throws away a reply that failed: a stranger gets the answer of a
    // reply that does not exist, and the reply is as it was
    name: 'message',
    create: (owner, { storeId }) => createDiscardableReplyOf(owner, { storeId, userId: reactorId }),
    readPath: id => ApiRoutes.conversations.messages(conversationOfMessage.get(id) ?? randomUUID()),
    modify: { path: id => ApiRoutes.messages.discard(id), method: 'post', body: {} },
    untouched: async (owner, id) => {
      const reply = await owner.message.findUnique({
        where: { id },
        select: { discardedAt: true, deletedAt: true, failureDefinitive: true }
      })
      return (
        reply?.discardedAt === null && reply.deletedAt === null && reply.failureDefinitive === true
      )
    }
  },
  {
    name: 'messageRevision',
    create: (owner, { storeId }) => createMessageRevisionOf(owner, { storeId, userId: reactorId }),
    // The revisions of a note are read through the note; a stranger can also try to edit it, and must
    // neither change the note nor add a revision to it
    readPath: id => ApiRoutes.messages.revisions(messageOfRevision.get(id) ?? randomUUID()),
    modify: {
      path: id => ApiRoutes.messages.byId(messageOfRevision.get(id) ?? randomUUID()),
      method: 'patch',
      body: { content: 'hacked', version: 2 }
    },
    untouched: async (owner, id) => {
      const revision = await owner.messageRevision.findUnique({
        where: { id },
        select: { content: true, messageId: true }
      })
      if (revision === null) return false
      const [note, revisions] = await Promise.all([
        owner.message.findUnique({
          where: { id: revision.messageId },
          select: { content: true, version: true }
        }),
        owner.messageRevision.count({ where: { messageId: revision.messageId } })
      ])
      return (
        revision.content === 'note v1' &&
        note?.content === 'note v2' &&
        note.version === 2 &&
        revisions === 1
      )
    }
  },
  {
    name: 'routingRule',
    create: createRoutingRule,
    readPath: ApiRoutes.settings.routingRuleById,
    listPath: ApiRoutes.settings.routing,
    modify: { path: ApiRoutes.settings.routingRuleById, body: { name: 'hacked-rule' } },
    untouched: async (owner, id) =>
      (await owner.routingRule.findUnique({ where: { id }, select: { name: true } }))?.name !==
      'hacked-rule',
    creation: {
      path: ApiRoutes.settings.routing,
      body: name => ({ name, conditions: {}, action: { type: RoutingActionTypes.UNASSIGNED } }),
      strict: true,
      countIn: (owner, storeId) => owner.routingRule.count({ where: { storeId } }),
      storeOf: async (owner, id) =>
        (await owner.routingRule.findUnique({ where: { id }, select: { storeId: true } }))
          ?.storeId ?? null
    }
  },
  {
    name: 'membership',
    create: (owner, { storeId }) => createMember(owner, { storeId, prefix }),
    listPath: ApiRoutes.settings.members,
    modify: {
      path: ApiRoutes.settings.memberById,
      get body() {
        return { roleId: viewerRoleId }
      }
    },
    untouched: async (owner, id) =>
      (await owner.membership.findUnique({ where: { id }, select: { roleId: true } }))?.roleId !==
      viewerRoleId
  },
  {
    // Suspending is another way to act on a membership by its id: a stranger's gets a 404 and the
    // member of the other store keeps their access
    name: 'membershipSuspend',
    create: (owner, { storeId }) => createMember(owner, { storeId, prefix }),
    modify: { path: ApiRoutes.settings.memberSuspend, method: 'post', body: {} },
    untouched: async (owner, id) =>
      (await owner.membership.findUnique({ where: { id }, select: { status: true } }))?.status ===
      MembershipStatus.ACTIVE
  },
  {
    // And so is reactivating: it must not give the access back to a member of another store
    name: 'membershipReactivate',
    create: async (owner, { storeId }) => {
      const made = await createMember(owner, { storeId, prefix })
      await owner.membership.update({
        where: { id: made.id },
        data: { status: MembershipStatus.SUSPENDED }
      })
      return made
    },
    modify: { path: ApiRoutes.settings.memberReactivate, method: 'post', body: {} },
    untouched: async (owner, id) =>
      (await owner.membership.findUnique({ where: { id }, select: { status: true } }))?.status ===
      MembershipStatus.SUSPENDED
  },
  {
    // Resending is a second way to act on an invitation by its id: a stranger's gets a 404 and no mail
    name: 'invitationResend',
    create: (owner, { storeId }) => createInvitation(owner, { storeId, prefix }),
    modify: { path: ApiRoutes.settings.invitationResend, method: 'post', body: {} },
    untouched: async (owner, id) =>
      (await owner.invitation.findUnique({ where: { id }, select: { status: true } }))?.status ===
      InvitationStatus.PENDING
  },
  {
    name: 'invitation',
    create: (owner, { storeId }) => createInvitation(owner, { storeId, prefix }),
    listPath: ApiRoutes.settings.invitations,
    // An invitation is revoked, not edited
    modify: { path: ApiRoutes.settings.invitationById, method: 'delete', body: {} },
    untouched: async (owner, id) =>
      (await owner.invitation.findUnique({ where: { id }, select: { status: true } }))?.status ===
      InvitationStatus.PENDING,
    creation: {
      path: ApiRoutes.settings.members,
      body: name => ({ email: `${prefix}-${name}@example.com`, roleId: agentRoleId }),
      strict: true,
      countIn: (owner, storeId) => owner.invitation.count({ where: { storeId } }),
      storeOf: async (owner, id) =>
        (await owner.invitation.findUnique({ where: { id }, select: { storeId: true } }))
          ?.storeId ?? null
    }
  },
  {
    name: 'role',
    create: createRole,
    listPath: ApiRoutes.settings.roles,
    modify: { path: ApiRoutes.settings.roleById, body: { name: 'hacked-role' } },
    untouched: async (owner, id) =>
      (await owner.role.findUnique({ where: { id }, select: { name: true } }))?.name !==
      'hacked-role',
    creation: {
      path: ApiRoutes.settings.roles,
      body: name => ({ name, permissions: [] }),
      strict: true,
      countIn: (owner, storeId) => owner.role.count({ where: { storeId } }),
      storeOf: async (owner, id) =>
        (await owner.role.findUnique({ where: { id }, select: { storeId: true } }))?.storeId ?? null
    }
  },
  // The signed download of a clean file. No route changes it (a file is replaced by uploading
  // another), so it has no `modify`. The upload routes have their own cases (describe "media upload").
  {
    name: 'media',
    create: (owner, { storeId }) =>
      owner.media.create({
        data: {
          storeId,
          purpose: 'message',
          key: StorageKeys.message(storeId, randomUUID(), 'photo.png'),
          filename: 'photo.png',
          contentType: 'image/png',
          fileSize: 68,
          status: 'clean'
        },
        select: { id: true }
      }),
    readPath: ApiRoutes.media.byId,
    untouched: async (owner, id) =>
      (await owner.media.findUnique({ where: { id }, select: { id: true } })) !== null
  },
  // The exports center shows a member only the exports they asked for, so the row is made by the
  // Admin of its store (the one the suite acts as). No route changes an export, so it has no `modify`.
  {
    name: 'export',
    create: async (owner, { storeId }) => {
      const admin = await owner.membership.findFirstOrThrow({
        where: { storeId, role: { name: RoleNames.ADMIN } },
        select: { userId: true }
      })
      return owner.export.create({
        data: {
          storeId,
          requestedBy: admin.userId,
          type: ExportTypes.CUSTOMERS,
          format: ExportFormats.CSV,
          expiresAt: new Date(Date.now() + 86_400_000)
        },
        select: { id: true }
      })
    },
    readPath: ApiRoutes.exports.byId,
    listPath: ApiRoutes.exports.list,
    untouched: async (owner, id) =>
      (await owner.export.findUnique({ where: { id }, select: { id: true } })) !== null
  },
  // Notifications are a person's own: the row is made for the Admin of its store (the one the suite
  // acts as) and the only way to change one is to mark it read, naming it in the body. There is no
  // route that reads one by id, so a stranger is only ever answered by the 404 of that route.
  {
    name: 'notification',
    create: async (owner, { storeId }) => {
      const admin = await owner.membership.findFirstOrThrow({
        where: { storeId, role: { name: RoleNames.ADMIN } },
        select: { userId: true }
      })
      return owner.notification.create({
        data: {
          userId: admin.userId,
          storeId,
          type: NotificationTypes.EXPORT_READY,
          severity: NotificationSeverity.SUCCESS,
          messageKey: notificationMessageKey(NotificationTypes.EXPORT_READY)
        },
        select: { id: true }
      })
    },
    listPath: ApiRoutes.notifications.list,
    modify: {
      path: () => ApiRoutes.notifications.markRead,
      method: 'post',
      body: id => ({ ids: [id] })
    },
    untouched: async (owner, id) =>
      (await owner.notification.findUnique({ where: { id }, select: { readAt: true } }))?.readAt ===
      null
  },
  // The choices of a member for one type, in one store: one row per store for the Admin the suite acts
  // as, reached through the store of the request (GET and PUT preferences). The marker is the `push`
  // flag: true for store A ('A'), false for store B ('B').
  {
    name: 'notificationPreference',
    create: async (owner, { storeId }) => {
      await setPreferencePush(owner, storeId, true)
      return { id: storeId }
    },
    readPath: () => ApiRoutes.notifications.preferences,
    own: {
      set: (owner, storeId, marker) => setPreferencePush(owner, storeId, marker === 'A'),
      markerIn: body => {
        const row = (body as { types: { type: string; push: boolean }[] }).types.find(
          candidate => candidate.type === PREFERENCE_TYPE
        )
        return row === undefined ? null : row.push ? 'A' : 'B'
      }
    },
    modify: {
      path: () => ApiRoutes.notifications.preferences,
      method: 'put',
      body: {
        types: [{ type: PREFERENCE_TYPE, inApp: true, push: false, email: false, sound: true }]
      }
    },
    untouched: async (owner, storeId) => {
      const admin = await adminOf(owner, storeId)
      return (
        (
          await owner.notificationPreference.findUnique({
            where: {
              userId_storeId_type: { userId: admin, storeId, type: PREFERENCE_TYPE }
            },
            select: { push: true }
          })
        )?.push === true
      )
    }
  }
]

// Every check has a sentence: the type makes the build fail for one that does not
const CHECKS = Object.keys(isolationChecks) as IsolationCheck[]
const SENTENCES: Record<IsolationCheck, string> = {
  otherOrganization: 'cannot be read by a user of another organization',
  claimingOwnStore: 'cannot be read by claiming the own store while asking for a row of another',
  siblingStore: 'cannot be read from a sibling store of the same organization',
  modification: 'cannot be changed across stores, and the row does not change',
  ownRow: 'gets the row of its own store, whatever other stores hold',
  listing: 'lists only the rows of the store of the request',
  creation: 'is created in the store of the header, whatever store the body names'
}

describe('Tenant isolation', () => {
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let scene: IsolationScene

  beforeAll(async () => {
    owner = ownerClient()
    // The login of the channels is on for the suite, so that its sessions can be tried against another store
    app = await createTestApp([], builder =>
      builder
        .overrideProvider(ChannelOAuthConfig)
        .useValue({ frontendUrl: 'https://app.example.com' })
    )
    ctx = await seedTestContext(owner, app, prefix)
    viewerRoleId = ctx.roleIds[RoleNames.VIEWER]
    transferWarehouses = { from: ctx.warehouseA.id, to: ctx.warehouseASecond.id }
    templateStores = [ctx.storeA.id, ctx.storeA2.id, ctx.storeB.id]
    agentRoleId = ctx.roleIds[RoleNames.AGENT]
    reactorId = ctx.adminA.id
    conversationInA = (await createConversationOf(owner, { storeId: ctx.storeA.id })).id
    // The shipping plugin is installed in store A, where the suite connects a carrier through the api
    await ensurePluginInstallation(owner, { storeId: ctx.storeA.id, pluginId: ShippingPlugin.ID })
    scene = { app, owner, ctx }
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  describe.each(resources)('$name', resource => {
    for (const check of CHECKS) {
      it(SENTENCES[check], async () => {
        await isolationChecks[check](scene, resource)
      })
    }
  })

  // The warehouses belong to the organization (TDD_16 §1, §8): the checks above prove that another organization reaches
  // none of them; these prove the rest of the rules of an organization-scoped resource, through the api
  describe('warehouses of an organization', () => {
    it('are the same for a member of any store of the organization, and none of the other organization', async () => {
      const own = await createWarehouse(owner, { organizationId: ctx.orgA.id })
      const foreign = await createWarehouse(owner, { organizationId: ctx.orgB.id })

      const fromSibling = await api(app, ctx.adminA2, ctx.storeA2)
        .get(ApiRoutes.warehouses.list)
        .query({ limit: 100 })

      expect(fromSibling.status).toBe(200)
      const ids = (fromSibling.body as { data: { id: string }[] }).data.map(row => row.id)
      expect(ids).toContain(own.id)
      expect(ids).not.toContain(foreign.id)
    })

    it('are not linked to a store of another organization, and nothing is written', async () => {
      const warehouse = await createWarehouse(owner, { organizationId: ctx.orgA.id })
      const linksOfB = await owner.storeWarehouse.count({ where: { storeId: ctx.storeB.id } })

      const response = await api(app, ctx.adminA, ctx.storeA)
        .put(ApiRoutes.warehouses.stores(warehouse.id))
        .send({ stores: [{ storeId: ctx.storeA.id }, { storeId: ctx.storeB.id }] })

      expect(response.status).toBe(404)
      expect(await owner.storeWarehouse.count({ where: { warehouseId: warehouse.id } })).toBe(0)
      expect(await owner.storeWarehouse.count({ where: { storeId: ctx.storeB.id } })).toBe(linksOfB)
    })

    it('of another organization cannot be linked, unlinked, renamed or switched off', async () => {
      const foreign = await createWarehouse(owner, { organizationId: ctx.orgB.id, name: 'theirs' })
      await linkWarehouse(owner, {
        organizationId: ctx.orgB.id,
        storeId: ctx.storeB.id,
        warehouseId: foreign.id
      })
      const agent = api(app, ctx.adminA, ctx.storeA)

      const attempts = [
        await agent
          .put(ApiRoutes.warehouses.stores(foreign.id))
          .send({ stores: [{ storeId: ctx.storeA.id }] }),
        await agent.put(ApiRoutes.warehouses.stores(foreign.id)).send({ stores: [] }),
        await agent
          .patch(ApiRoutes.warehouses.byId(foreign.id))
          .send({ name: 'mine now', active: false })
      ]

      expect(attempts.map(attempt => attempt.status)).toEqual([404, 404, 404])
      const row = await owner.warehouse.findUniqueOrThrow({ where: { id: foreign.id } })
      expect(row).toMatchObject({ name: 'theirs', active: true })
      const links = await owner.storeWarehouse.findMany({ where: { warehouseId: foreign.id } })
      expect(links.map(link => link.storeId)).toEqual([ctx.storeB.id])
    })

    it('are not reached through the header of a store of another organization', async () => {
      const own = await createWarehouse(owner, { organizationId: ctx.orgA.id })

      const response = await api(app, ctx.adminA, ctx.storeB).get(ApiRoutes.warehouses.byId(own.id))

      expect(response.status).toBe(403)
    })
  })

  // The transfers belong to the organization, their lines to the stores whose products travel (TDD_16 §1, §8): the
  // checks above prove that another organization reaches none of them; these prove that line visibility is the
  // caller's stores
  describe('transfers of an organization', () => {
    it("show a member only the lines of their stores, though the header is the organization's", async () => {
      const own = await createTransfer(owner, {
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id
      })
      const sibling = await owner.product.create({
        data: { storeId: ctx.storeA2.id, name: `p-${randomUUID().slice(0, 6)}`, priceCents: 100 },
        select: { id: true }
      })
      await owner.stockTransferLine.create({
        data: { transferId: own.id, storeId: ctx.storeA2.id, productId: sibling.id, quantity: 2 }
      })

      const fromA = await api(app, ctx.adminA, ctx.storeA).get(ApiRoutes.transfers.byId(own.id))
      const fromA2 = await api(app, ctx.adminA2, ctx.storeA2).get(ApiRoutes.transfers.byId(own.id))

      const storesOf = (response: { body: unknown }): string[] =>
        (response.body as { lines: { storeId: string }[] }).lines.map(line => line.storeId)
      expect(fromA.status).toBe(200)
      expect(storesOf(fromA)).toEqual([ctx.storeA.id])
      expect(fromA2.status).toBe(200)
      expect(storesOf(fromA2)).toEqual([ctx.storeA2.id])
    })

    it('are not reached through the header of a store of another organization', async () => {
      const own = await createTransfer(owner, {
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id
      })

      const response = await api(app, ctx.adminA, ctx.storeB).get(ApiRoutes.transfers.byId(own.id))

      expect(response.status).toBe(403)
    })

    it('of another organization cannot be edited, dispatched, received, closed or cancelled', async () => {
      const foreign = await createTransfer(owner, {
        organizationId: ctx.orgB.id,
        storeId: ctx.storeB.id,
        status: TransferStatus.IN_TRANSIT
      })
      const agent = api(app, ctx.adminA, ctx.storeA)

      const attempts = [
        await agent.patch(ApiRoutes.transfers.byId(foreign.id)).send({ note: 'mine now' }),
        await agent.post(ApiRoutes.transfers.dispatch(foreign.id)),
        await agent
          .post(ApiRoutes.transfers.receive(foreign.id))
          .send({ receiptKey: randomUUID(), lines: [{ lineId: foreign.lineId, quantity: 1 }] }),
        await agent.post(ApiRoutes.transfers.close(foreign.id)).send({ lines: [] }),
        await agent.post(ApiRoutes.transfers.cancel(foreign.id))
      ]

      expect(attempts.map(attempt => attempt.status)).toEqual([404, 404, 404, 404, 404])
      const row = await owner.stockTransfer.findUniqueOrThrow({
        where: { id: foreign.id },
        include: { lines: true }
      })
      expect(row).toMatchObject({ status: TransferStatus.IN_TRANSIT, note: null })
      expect(row.lines.map(line => line.receivedQuantity)).toEqual([0])
    })

    it('do not take a warehouse of another organization', async () => {
      const mine = await createWarehouse(owner, { organizationId: ctx.orgA.id })

      const response = await api(app, ctx.adminA, ctx.storeA)
        .post(ApiRoutes.transfers.create)
        .send({ fromWarehouseId: mine.id, toWarehouseId: ctx.warehouseB.id })

      expect(response.status).toBe(404)
    })
  })

  // The inventory switches belong to the store of the header: the settings row is one per store
  describe('inventory settings', () => {
    it('are changed only in the store of the header, never in one the user does not belong to', async () => {
      const before = await owner.storeSettings.findUniqueOrThrow({
        where: { storeId: ctx.storeB.id }
      })

      const response = await api(app, ctx.adminA, ctx.storeB)
        .patch(ApiRoutes.settings.inventory)
        .send({ allowNegativeStock: true, defaultLowStockThreshold: 9 })
      const read = await api(app, ctx.adminA, ctx.storeB).get(ApiRoutes.settings.inventory)
      const named = await api(app, ctx.adminA, ctx.storeA)
        .patch(ApiRoutes.settings.inventory)
        .send({ allowNegativeStock: true, storeId: ctx.storeB.id })

      expect(response.status).toBe(403)
      expect(read.status).toBe(403)
      expect(named.status).toBe(400)
      const after = await owner.storeSettings.findUniqueOrThrow({
        where: { storeId: ctx.storeB.id }
      })
      expect(after.allowNegativeStock).toBe(before.allowNegativeStock)
      expect(after.defaultLowStockThreshold).toBe(before.defaultLowStockThreshold)
    })
  })

  // The read of a media is in the list of resources above. The upload routes are proven here: the
  // store of a signed URL and of a confirmation is the one of the header, and a key of another store
  // is never accepted.
  describe('media upload', () => {
    const uploadBody = {
      purpose: 'message',
      filename: 'photo.png',
      contentType: 'image/png',
      fileSizeBytes: 68
    }

    it('signs a key inside the store of the header, never one the body names', async () => {
      const own = await api(app, ctx.adminA, ctx.storeA)
        .post(ApiRoutes.media.uploadUrl)
        .send(uploadBody)
      expect(own.status).toBe(200)
      expect((own.body as { key: string }).key).toMatch(
        new RegExp(`^${StorageKeys.storePrefix(ctx.storeA.id)}uploads/`)
      )
      const named = await api(app, ctx.adminA, ctx.storeA)
        .post(ApiRoutes.media.uploadUrl)
        .send({ ...uploadBody, storeId: ctx.storeB.id })
      expect(named.status).toBe(400)
      expect((named.body as { error: { code: string } }).error.code).toBe(
        ErrorCodes.VALIDATION_FAILED
      )
    })

    it('is refused in a store the user does not belong to, on both routes', async () => {
      for (const path of [ApiRoutes.media.uploadUrl, ApiRoutes.media.confirmUpload]) {
        const response = await api(app, ctx.adminA, ctx.storeB).post(path).send(uploadBody)
        expect(response.status).toBe(403)
        expect((response.body as { error: { code: string } }).error.code).toBe(
          ErrorCodes.TENANT_ACCESS_DENIED
        )
      }
    })

    it('does not confirm the object of another store, and writes no row in either', async () => {
      const mediaId = randomUUID()
      const foreignKey = StorageKeys.messageUpload(ctx.storeB.id, mediaId, 'photo.png')
      const response = await api(app, ctx.adminA, ctx.storeA)
        .post(ApiRoutes.media.confirmUpload)
        .send({ ...uploadBody, mediaId, key: foreignKey })
      expect(response.status).toBe(403)
      expect((response.body as { error: { code: string } }).error.code).toBe(
        ErrorCodes.FILE_KEY_OUT_OF_SCOPE
      )
      expect(await owner.media.count({ where: { id: mediaId } })).toBe(0)
    })

    it('does not attach a file to a product of another store, on either route, and writes no row', async () => {
      const foreignProduct = await owner.product.create({
        data: { storeId: ctx.storeB.id, name: `${prefix}-foreign-product`, priceCents: 100 },
        select: { id: true }
      })
      const productBody = { ...uploadBody, purpose: 'product', parentId: foreignProduct.id }
      const signed = await api(app, ctx.adminA, ctx.storeA)
        .post(ApiRoutes.media.uploadUrl)
        .send(productBody)
      const missing = await api(app, ctx.adminA, ctx.storeA)
        .post(ApiRoutes.media.uploadUrl)
        .send({ ...productBody, parentId: randomUUID() })
      // Another store's product and one that does not exist are the same answer: no probing of ids
      expect(signed.status).toBe(404)
      expect(missing.status).toBe(404)
      expect((signed.body as { error: unknown }).error).toEqual(
        (missing.body as { error: unknown }).error
      )
      const mediaId = randomUUID()
      const confirmed = await api(app, ctx.adminA, ctx.storeA)
        .post(ApiRoutes.media.confirmUpload)
        .send({
          ...productBody,
          mediaId,
          key: StorageKeys.messageUpload(ctx.storeA.id, mediaId, 'photo.png')
        })
      expect(confirmed.status).toBe(404)
      expect(await owner.media.count({ where: { productId: foreignProduct.id } })).toBe(0)
      expect(await owner.media.count({ where: { id: mediaId } })).toBe(0)
    })

    it('does not list the pictures of a product of another store, nor take its file as a cover', async () => {
      const foreign = await owner.product.create({
        data: { storeId: ctx.storeB.id, name: `${prefix}-cover-product`, priceCents: 100 },
        select: { id: true }
      })
      const file = await owner.media.create({
        data: {
          storeId: ctx.storeB.id,
          productId: foreign.id,
          purpose: 'product',
          key: StorageKeys.message(ctx.storeB.id, randomUUID(), 'photo.png'),
          filename: 'photo.png',
          contentType: 'image/png',
          fileSize: 68,
          status: 'clean'
        },
        select: { id: true }
      })
      const mine = await owner.product.create({
        data: { storeId: ctx.storeA.id, name: `${prefix}-mine`, priceCents: 100 },
        select: { id: true }
      })
      const listed = await api(app, ctx.adminA, ctx.storeA).get(
        ApiRoutes.products.images(foreign.id)
      )
      expect(listed.status).toBe(404)
      const cover = await api(app, ctx.adminA, ctx.storeA)
        .patch(ApiRoutes.products.byId(mine.id))
        .send({ imageMediaId: file.id })
      expect(cover.status).toBe(404)
      expect(
        (await owner.product.findUniqueOrThrow({ where: { id: mine.id } })).imageMediaId
      ).toBeNull()
    })

    it('does not let the id of a media of another store be taken over from this one', async () => {
      const row = await owner.media.create({
        data: {
          storeId: ctx.storeB.id,
          purpose: 'message',
          key: StorageKeys.message(ctx.storeB.id, randomUUID(), 'photo.png'),
          filename: 'photo.png',
          contentType: 'image/png',
          fileSize: 68
        }
      })
      // The object is really there at the key store A would use for that id: the only thing left to
      // refuse the confirmation is that the id belongs to a row of store B
      const storage = app.get(StorageService, { strict: false })
      const stagingKey = StorageKeys.messageUpload(ctx.storeA.id, row.id, 'photo.png')
      const url = await storage.uploadUrl({
        key: stagingKey,
        contentType: 'image/png',
        contentLength: 68
      })
      const put = await fetch(url, {
        method: 'PUT',
        headers: { 'content-type': 'image/png', 'content-length': '68' },
        body: new Uint8Array(68)
      })
      expect(put.status).toBe(200)

      const response = await api(app, ctx.adminA, ctx.storeA)
        .post(ApiRoutes.media.confirmUpload)
        .send({ ...uploadBody, mediaId: row.id, key: stagingKey })

      expect(response.status).toBe(400)
      expect((response.body as { error: { code: string } }).error.code).toBe(
        ErrorCodes.FILE_UPLOAD_FAILED
      )
      // The row of store B is as it was, and store A got none
      expect(
        await owner.media.findUniqueOrThrow({
          where: { id: row.id },
          select: { storeId: true, key: true, uploadedBy: true, status: true }
        })
      ).toEqual({ storeId: ctx.storeB.id, key: row.key, uploadedBy: null, status: 'pending' })
      expect(await owner.media.count({ where: { id: row.id, storeId: ctx.storeA.id } })).toBe(0)
      await storage.delete(stagingKey)
    })
  })

  // The autocomplete of products reads the store of the header only: the products and the variants of another
  // store are never in its answer, by name, by sku or by the sku of a variant, and a store the user does not belong
  // to is refused before the search runs.
  // The adjustment is the one route that writes stock: it never takes the store from the body, and what it names (the
  // product, the warehouse) must be of the store of the header and of its organization.
  describe('stock adjustments', () => {
    const adjust = (
      agent: ReturnType<typeof api>,
      body: Record<string, unknown>
    ): ReturnType<ReturnType<typeof api>['post']> =>
      agent.post(ApiRoutes.inventory.adjustments).send({
        type: 'adjustment_in',
        quantity: 1,
        reason: 'found',
        idempotencyKey: randomUUID(),
        ...body
      })

    it('does not take the store from the body', async () => {
      const product = await createProduct(owner, { storeId: ctx.storeA.id })
      const before = await owner.inventoryMovement.count({ where: { storeId: ctx.storeB.id } })

      const response = await adjust(api(app, ctx.adminA, ctx.storeA), {
        productId: product.id,
        warehouseId: ctx.warehouseA.id,
        storeId: ctx.storeB.id
      })

      expect(response.status).toBe(400)
      expect(await owner.inventoryMovement.count({ where: { storeId: ctx.storeB.id } })).toBe(
        before
      )
    })

    it('answers 404 for the product of another store and for the warehouse of another organization', async () => {
      const mine = await createProduct(owner, { storeId: ctx.storeA.id })
      const theirs = await createProduct(owner, { storeId: ctx.storeB.id })
      const agent = api(app, ctx.adminA, ctx.storeA)

      const foreignProduct = await adjust(agent, {
        productId: theirs.id,
        warehouseId: ctx.warehouseA.id
      })
      const foreignWarehouse = await adjust(agent, {
        productId: mine.id,
        warehouseId: ctx.warehouseB.id
      })

      expect(foreignProduct.status).toBe(404)
      expect(foreignWarehouse.status).toBe(404)
      expect(await owner.inventoryMovement.count({ where: { productId: mine.id } })).toBe(0)
      expect(await owner.inventoryMovement.count({ where: { productId: theirs.id } })).toBe(0)
      expect(
        await owner.inventoryLevel.count({ where: { productId: { in: [mine.id, theirs.id] } } })
      ).toBe(0)
    })

    it('is refused in a store the user does not belong to', async () => {
      const product = await createProduct(owner, { storeId: ctx.storeB.id })

      const response = await adjust(api(app, ctx.adminA, ctx.storeB), {
        productId: product.id,
        warehouseId: ctx.warehouseB.id
      })

      expect(response.status).toBe(403)
      expect(await owner.inventoryMovement.count({ where: { productId: product.id } })).toBe(0)
    })

    it('keeps the idempotency keys of a store to itself', async () => {
      const mine = await createProduct(owner, { storeId: ctx.storeA.id })
      const theirs = await createProduct(owner, { storeId: ctx.storeB.id })
      const key = randomUUID()
      const first = await adjust(api(app, ctx.adminB, ctx.storeB), {
        productId: theirs.id,
        warehouseId: ctx.warehouseB.id,
        idempotencyKey: key
      })
      expect(first.status).toBe(201)

      // The same key in another store is a new movement: no conflict, no replay of somebody else's answer
      const second = await adjust(api(app, ctx.adminA, ctx.storeA), {
        productId: mine.id,
        warehouseId: ctx.warehouseA.id,
        idempotencyKey: key
      })

      expect(second.status).toBe(201)
      expect((second.body as { movement: { productId: string } }).movement.productId).toBe(mine.id)
    })
  })

  describe('product search', () => {
    it('never finds the products or variants of another store', async () => {
      const word = `iso${randomUUID().slice(0, 6)}`
      const foreign = await createProduct(owner, {
        storeId: ctx.storeB.id,
        name: `${word} theirs`,
        sku: `${word}-SKU`
      })
      await createProductVariant(owner, {
        productId: foreign.id,
        name: `${word} variant`,
        sku: `${word}-VAR`
      })

      for (const q of [word, `${word}-SKU`, `${word}-VAR`, `${word} variant`]) {
        const found = await api(app, ctx.adminA, ctx.storeA)
          .get(ApiRoutes.products.search)
          .query({ q })
        expect(found.status).toBe(200)
        expect((found.body as { data: unknown[] }).data).toEqual([])
      }
      const own = await api(app, ctx.adminB, ctx.storeB)
        .get(ApiRoutes.products.search)
        .query({ q: word })
      expect((own.body as { data: { id: string }[] }).data.map(item => item.id)).toEqual([
        foreign.id
      ])
    })

    it('is refused in a store the user does not belong to', async () => {
      const refused = await api(app, ctx.adminA, ctx.storeB)
        .get(ApiRoutes.products.search)
        .query({ q: 'anything' })
      expect(refused.status).toBe(403)
    })
  })

  // The search reads customers, messages, orders and products with raw SQL, so the store filter is written by hand in
  // each statement: a word that only another store holds is never found, on any route, nor by the global one, and
  // the store comes from the header only (a `storeId` in the query string is a 400, not an override)
  describe('search', () => {
    const word = `srch${randomUUID().slice(0, 6)}`
    const routes = [
      ApiRoutes.search.global,
      ApiRoutes.search.messages,
      ApiRoutes.search.customers,
      ApiRoutes.search.orders,
      ApiRoutes.search.products
    ]

    it('never finds what another store holds, on any route', async () => {
      const customer = await createCustomer(owner, {
        storeId: ctx.storeB.id,
        name: `${word} Ñandú`
      })
      const conversation = await createConversationOf(owner, { storeId: ctx.storeB.id })
      await createMessage(owner, {
        storeId: ctx.storeB.id,
        conversationId: conversation.id,
        content: `texto ${word} de la otra tienda`
      })
      const order = await createOrder(owner, { storeId: ctx.storeB.id })
      await owner.order.update({ where: { id: order.id }, data: { orderNumber: `${word}-9001` } })
      await createProduct(owner, {
        storeId: ctx.storeB.id,
        name: `${word} producto`,
        sku: `${word}-SKU`
      })

      for (const route of routes) {
        for (const q of [word, `${word} nandu`, `${word}-9001`, `${word}-SKU`]) {
          const found = await api(app, ctx.adminA, ctx.storeA).get(route).query({ q })
          expect(found.status).toBe(200)
          const body = found.body as { hits?: unknown[]; data?: unknown[]; groups?: unknown[] }
          expect(body.hits ?? body.data ?? body.groups).toEqual([])
        }
      }
      // The owner of the data does find it, so the empty answers above are not an empty database
      const own = await api(app, ctx.adminB, ctx.storeB)
        .get(ApiRoutes.search.customers)
        .query({ q: word })
      expect((own.body as { hits: { id: string }[] }).hits.map(hit => hit.id)).toEqual([
        customer.id
      ])
    })

    it('does not take the store from the query string', async () => {
      for (const route of routes) {
        const forged = await api(app, ctx.adminA, ctx.storeA)
          .get(route)
          .query({ q: word, storeId: ctx.storeB.id })
        expect(forged.status).toBe(400)
      }
    })

    it('is refused in a store the user does not belong to', async () => {
      for (const route of routes) {
        const refused = await api(app, ctx.adminA, ctx.storeB).get(route).query({ q: 'anything' })
        expect(refused.status).toBe(403)
      }
    })

    it('never shows the messages of another store in a conversation named by id', async () => {
      const conversation = await createConversationOf(owner, { storeId: ctx.storeB.id })
      await createMessage(owner, {
        storeId: ctx.storeB.id,
        conversationId: conversation.id,
        content: `hilo ${word}`
      })
      const found = await api(app, ctx.adminA, ctx.storeA)
        .get(ApiRoutes.search.messages)
        .query({ q: word, conversationId: conversation.id })
      expect(found.status).toBe(200)
      expect((found.body as { hits: unknown[] }).hits).toEqual([])
    })
  })

  // The gallery of a customer and "Download all" name the customer in the path or the body, so the
  // store that decides is the one of the header: a customer of another store is a 404 on both, and
  // a file of another store is never listed or zipped, even if its row names this customer.
  describe('media gallery', () => {
    it('answers 404 for a customer of another store, on the gallery and on "Download all"', async () => {
      const foreign = await createCustomer(owner, { storeId: ctx.storeB.id })
      await owner.media.create({
        data: {
          storeId: ctx.storeB.id,
          purpose: 'message',
          customerId: foreign.id,
          key: StorageKeys.message(ctx.storeB.id, randomUUID(), 'theirs.png'),
          filename: 'theirs.png',
          contentType: 'image/png',
          fileSize: 10,
          status: 'clean'
        }
      })
      const exportsBefore = await owner.export.count({ where: { storeId: ctx.storeA.id } })

      const gallery = await api(app, ctx.adminA, ctx.storeA).get(
        ApiRoutes.customers.media(foreign.id)
      )
      const zip = await api(app, ctx.adminA, ctx.storeA)
        .post(ApiRoutes.media.downloadAll)
        .send({ customerId: foreign.id })

      expect(gallery.status).toBe(404)
      expect(zip.status).toBe(404)
      expect(await owner.export.count({ where: { storeId: ctx.storeA.id } })).toBe(exportsBefore)
    })

    it('is refused in a store the user does not belong to', async () => {
      const own = await createCustomer(owner, { storeId: ctx.storeA.id })
      const gallery = await api(app, ctx.adminA, ctx.storeB).get(ApiRoutes.customers.media(own.id))
      const zip = await api(app, ctx.adminA, ctx.storeB)
        .post(ApiRoutes.media.downloadAll)
        .send({ customerId: own.id })
      expect(gallery.status).toBe(403)
      expect(zip.status).toBe(403)
    })
  })

  // TDD_13 section 6: the widget is public, so the key it carries is all that says which store it is
  // talking to. The case was waiting for the step that builds it (Step 2.8)
  describe('a widget site key', () => {
    const SITE_A = 'https://shop-a.example'
    const SITE_B = 'https://shop-b.example'
    const siteKey = (letter: string): string => `pk_widget_${letter.repeat(24)}`
    const widget = async (storeId: string, key: string, origin: string): Promise<void> => {
      const installation = await ensurePluginInstallation(owner, {
        storeId,
        pluginId: ChannelIds.WEB_WIDGET
      })
      await owner.channelConnection.create({
        data: {
          storeId,
          pluginId: ChannelIds.WEB_WIDGET,
          installationId: installation.id,
          connectionId: key,
          displayName: origin,
          credentials: Buffer.from('{}'),
          metadata: { allowedOrigins: [origin] }
        }
      })
    }
    const bootstrap = (key: string, visitorId: string, origin: string) =>
      anonymousApi(app)
        .post(ApiRoutes.widget.bootstrap)
        .set('origin', origin)
        .send({ siteKey: key, visitorId })

    beforeAll(async () => {
      await widget(ctx.storeA.id, siteKey('A'), SITE_A)
      await widget(ctx.storeB.id, siteKey('B'), SITE_B)
    })

    it('is not accepted from the site of another store', async () => {
      const response = await bootstrap(siteKey('A'), randomUUID(), SITE_B)

      expect(response.status).toBe(403)
      expect((response.body as { error: { code: string } }).error.code).toBe(
        ErrorCodes.WIDGET_ORIGIN_NOT_ALLOWED
      )
    })

    it('is neither read nor changed through the settings of another store', async () => {
      const connection = await owner.channelConnection.findFirstOrThrow({
        where: { connectionId: siteKey('A') },
        select: { id: true }
      })

      const read = await api(app, ctx.adminB, ctx.storeB).get(
        ApiRoutes.channels.widgetEmbed(connection.id)
      )
      const write = await api(app, ctx.adminB, ctx.storeB)
        .put(ApiRoutes.channels.widgetOrigins(connection.id))
        .send({ siteOrigins: [SITE_B] })

      const preChat = await api(app, ctx.adminB, ctx.storeB)
        .put(ApiRoutes.channels.widgetPreChat(connection.id))
        .send({ enabled: true })

      expect(read.status).toBe(404)
      expect(write.status).toBe(404)
      expect(preChat.status).toBe(404)
      const row = await owner.channelConnection.findUniqueOrThrow({ where: { id: connection.id } })
      expect(row.metadata).toEqual({ allowedOrigins: [SITE_A] })
    })

    it('shows a visitor only the conversation they had with the store of the key', async () => {
      const visitorId = randomUUID()
      const identity = await createCustomerIdentity(owner, {
        storeId: ctx.storeA.id,
        channelType: ChannelIds.WEB_WIDGET,
        handle: visitorId
      })
      const connection = await owner.channelConnection.findFirstOrThrow({
        where: { connectionId: siteKey('A') },
        select: { id: true }
      })
      const conversation = await owner.conversation.create({
        data: {
          storeId: ctx.storeA.id,
          customerId: identity.customerId,
          customerIdentityId: identity.id,
          channelConnectionId: connection.id,
          channelType: ChannelIds.WEB_WIDGET
        },
        select: { id: true }
      })
      await owner.message.create({
        data: {
          storeId: ctx.storeA.id,
          conversationId: conversation.id,
          type: MessageType.TEXT,
          content: 'SecretOfStoreA',
          authorType: 'customer'
        }
      })

      const own = await bootstrap(siteKey('A'), visitorId, SITE_A)
      const other = await bootstrap(siteKey('B'), visitorId, SITE_B)

      expect(JSON.stringify(own.body)).toContain('SecretOfStoreA')
      expect(other.status).toBe(200)
      expect(JSON.stringify(other.body)).not.toContain('SecretOfStoreA')
    })
  })

  describe('the store of a request', () => {
    it('is required: a request with a token and no X-Store-Id is refused', async () => {
      const response = await apiWithoutStore(app, ctx.adminA).get(ApiRoutes.settings.tags)

      expect(response.status).toBe(400)
      expect((response.body as { error: { code: string } }).error.code).toBe(
        ErrorCodes.TENANT_HEADER_MISSING
      )
    })

    it('is never taken from the query: a storeId there does not stand in for the header', async () => {
      const response = await apiWithoutStore(app, ctx.adminA)
        .get(ApiRoutes.settings.tags)
        .query({ storeId: ctx.storeA.id })

      expect(response.status).toBe(400)
    })

    it('is useless without a token', async () => {
      const response = await anonymousApi(app).get(ApiRoutes.settings.tags)

      expect(response.status).toBe(401)
    })

    it('is not the one of another user: a token and the header of a store the user lacks', async () => {
      const response = await anonymousApi(app)
        .get(ApiRoutes.settings.tags)
        .set('authorization', `Bearer ${ctx.adminB.token}`)
        .set(TenantHeaders.STORE_ID, ctx.storeA.id)

      expect(response.status).toBe(403)
    })
  })

  // GET /auth/me belongs to a person and takes no store: what it lists is decided by whose token it is
  describe('the memberships of the account', () => {
    it('are the ones of the caller: a user never reads the stores of another organization', async () => {
      const response = await anonymousApi(app)
        .get(ApiRoutes.auth.me)
        .set('authorization', `Bearer ${ctx.adminA.token}`)

      const stores = (response.body as { memberships: { storeId: string }[] }).memberships.map(
        membership => membership.storeId
      )
      expect(response.status).toBe(200)
      expect(stores).toContain(ctx.storeA.id)
      expect(stores).not.toContain(ctx.storeB.id)
    })

    it('are the ones of the caller from the other side too', async () => {
      const response = await anonymousApi(app)
        .get(ApiRoutes.auth.me)
        .set('authorization', `Bearer ${ctx.adminB.token}`)

      const stores = (response.body as { memberships: { storeId: string }[] }).memberships.map(
        membership => membership.storeId
      )
      expect(stores).toContain(ctx.storeB.id)
      expect(stores).not.toContain(ctx.storeA.id)
    })
  })

  describe('the directory of members', () => {
    it('lists the members of the store of the caller, with nobody of another store in it', async () => {
      const response = await api(app, ctx.adminA, ctx.storeA).get(ApiRoutes.members.directory)

      expect(response.status).toBe(200)
      expect(JSON.stringify(response.body)).toContain(ctx.adminA.id)
      expect(JSON.stringify(response.body)).not.toContain(ctx.adminB.id)
    })

    it('is refused for a store the user does not belong to', async () => {
      const response = await anonymousApi(app)
        .get(ApiRoutes.members.directory)
        .set('authorization', `Bearer ${ctx.adminB.token}`)
        .set(TenantHeaders.STORE_ID, ctx.storeA.id)

      expect(response.status).toBe(403)
    })
  })

  describe('the behavior of the inbox', () => {
    it('is the timezone and the settings of the store of the caller, never those of another', async () => {
      const before = await owner.store.findMany({
        where: { id: { in: [ctx.storeA.id, ctx.storeB.id] } },
        select: { id: true, timezone: true }
      })
      const zoneA = 'Asia/Tokyo'
      const zoneB = 'Europe/Madrid'
      await owner.store.update({ where: { id: ctx.storeA.id }, data: { timezone: zoneA } })
      await owner.store.update({ where: { id: ctx.storeB.id }, data: { timezone: zoneB } })
      await owner.storeSettings.update({
        where: { storeId: ctx.storeA.id },
        data: { resolveShowOptions: false }
      })
      await owner.storeSettings.update({
        where: { storeId: ctx.storeB.id },
        data: { resolveShowOptions: true }
      })
      try {
        const a = await api(app, ctx.adminA, ctx.storeA).get(ApiRoutes.settings.inboxBehavior)
        const b = await api(app, ctx.adminB, ctx.storeB).get(ApiRoutes.settings.inboxBehavior)

        expect(a.body).toMatchObject({ timezone: zoneA, resolveShowOptions: false })
        expect(b.body).toMatchObject({ timezone: zoneB, resolveShowOptions: true })
      } finally {
        for (const store of before) {
          await owner.store.update({ where: { id: store.id }, data: { timezone: store.timezone } })
        }
        await owner.storeSettings.updateMany({
          where: { storeId: { in: [ctx.storeA.id, ctx.storeB.id] } },
          data: { resolveShowOptions: true }
        })
      }
    })

    it('is refused for a store the user does not belong to', async () => {
      const response = await anonymousApi(app)
        .get(ApiRoutes.settings.inboxBehavior)
        .set('authorization', `Bearer ${ctx.adminB.token}`)
        .set(TenantHeaders.STORE_ID, ctx.storeA.id)

      expect(response.status).toBe(403)
    })
  })

  describe('naming a connection', () => {
    it('is answered as a connection that does not exist when it belongs to another store, and changes nothing', async () => {
      const connectionA = await createChannelConnection(owner, {
        storeId: ctx.storeA.id,
        channelType: 'test_channel'
      })

      const foreign = await api(app, ctx.adminB, ctx.storeB)
        .put(ApiRoutes.channels.label(connectionA.id))
        .send({ label: 'Taken by the other store' })
      const missing = await api(app, ctx.adminB, ctx.storeB)
        .put(ApiRoutes.channels.label(randomUUID()))
        .send({ label: 'Taken by the other store' })

      expect(foreign.status).toBe(404)
      expect(missing.status).toBe(404)
      expect((foreign.body as { error: unknown }).error).toEqual(
        (missing.body as { error: unknown }).error
      )
      const after = await owner.channelConnection.findUniqueOrThrow({
        where: { id: connectionA.id }
      })
      expect(after.label).toBeNull()
    })
  })

  describe('replacing the token of a connection', () => {
    it('is answered as a connection that does not exist when it belongs to another store, and leaves its credentials alone', async () => {
      const connectionA = await createChannelConnection(owner, {
        storeId: ctx.storeA.id,
        channelType: 'test_channel'
      })
      const before = await owner.channelConnection.findUniqueOrThrow({
        where: { id: connectionA.id }
      })

      const foreign = await api(app, ctx.adminB, ctx.storeB)
        .post(ApiRoutes.channels.updateToken(connectionA.id))
        .send({ credentials: { token: 'EAAB-from-the-other-store' } })
      const missing = await api(app, ctx.adminB, ctx.storeB)
        .post(ApiRoutes.channels.updateToken(randomUUID()))
        .send({ credentials: { token: 'EAAB-from-the-other-store' } })

      expect(foreign.status).toBe(404)
      expect(missing.status).toBe(404)
      expect((foreign.body as { error: unknown }).error).toEqual(
        (missing.body as { error: unknown }).error
      )
      const after = await owner.channelConnection.findUniqueOrThrow({
        where: { id: connectionA.id }
      })
      expect(Buffer.from(after.credentials).equals(Buffer.from(before.credentials))).toBe(true)
    })
  })

  // Step 7.8, rule 3 of CLAUDE.md: a login session is not a table but it is tenant data (it holds the token of
  // a person for one store), so it has its case here. The callback is public and knows no store: the store is
  // in the state that the authenticated start made, and every later step compares it with the store of the call.
  describe('the login session of a channel', () => {
    const LOGIN_PLUGIN = 'iso_login'
    let registry: PluginRegistry

    beforeAll(async () => {
      registry = app.get(PluginRegistry, { strict: false })
      registry.register(
        buildChannelPlugin({
          id: LOGIN_PLUGIN,
          oauth: {
            kind: 'authorization-code-with-assets',
            redirectUri: registry.oauthCallbackUrl ?? null,
            dialogOrigin: 'https://dialog.example',
            providerName: { es: 'Ejemplo', en: 'Example' },
            linkedAccount: null,
            assetIdPattern: '^\\d{1,32}$',
            scopes: ['pages_show_list'],
            authorizationUrl: ({ state, redirectUri }) =>
              `https://dialog.example/oauth?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`,
            exchangeCode: () => Promise.resolve('USER-TOKEN-OF-A'),
            grantedScopes: () => Promise.resolve(['pages_show_list']),
            listAssets: () =>
              Promise.resolve([{ id: '1100', name: 'Page of A', linkedAccount: null }]),
            credentialsFor: ({ assetId }) => Promise.resolve({ token: `PAGE-${assetId}` })
          }
        })
      )
      for (const store of [ctx.storeA, ctx.storeB]) {
        await ensurePluginInstallation(owner, { storeId: store.id, pluginId: LOGIN_PLUGIN })
      }
    })
    afterAll(() => {
      registry.unregister(LOGIN_PLUGIN)
    })

    it('is answered as a session that does not exist when it belongs to another store, and makes no connection there', async () => {
      const started = await api(app, ctx.adminA, ctx.storeA).post(
        ApiRoutes.channels.oauthStart(LOGIN_PLUGIN)
      )
      const state = new URL(
        (started.body as { authorizeUrl: string }).authorizeUrl
      ).searchParams.get('state')
      const back = await anonymousApi(app)
        .get(ApiRoutes.channels.oauthCallback)
        .query({ code: 'a-code', state })
        .redirects(0)
      const session = new URL(String(back.headers['location'])).searchParams.get('oauth') ?? ''
      const never = 'z'.repeat(43)
      const before = await owner.channelConnection.count({ where: { pluginId: LOGIN_PLUGIN } })

      const asB = (): ReturnType<typeof api> => api(app, ctx.adminB, ctx.storeB)
      const answers = [
        [
          await asB().get(ApiRoutes.channels.oauthAssets(session)),
          await asB().get(ApiRoutes.channels.oauthAssets(never))
        ],
        [
          await asB().post(ApiRoutes.channels.oauthComplete(session)).send({ assetId: '1100' }),
          await asB().post(ApiRoutes.channels.oauthComplete(never)).send({ assetId: '1100' })
        ],
        [
          await asB().delete(ApiRoutes.channels.oauthSession(session)),
          await asB().delete(ApiRoutes.channels.oauthSession(never))
        ]
      ]
      for (const [foreign, missing] of answers) {
        expect(foreign?.status).toBe(404)
        expect(missing?.status).toBe(404)
        expect((foreign?.body as { error: unknown }).error).toEqual(
          (missing?.body as { error: unknown }).error
        )
      }
      expect(await owner.channelConnection.count({ where: { pluginId: LOGIN_PLUGIN } })).toBe(
        before
      )
      // The owner of the session still has it: the other store changed nothing
      const own = await api(app, ctx.adminA, ctx.storeA).get(
        ApiRoutes.channels.oauthAssets(session)
      )
      expect(own.status).toBe(200)
    })

    it('cannot repair a connection of another store: it is answered as one that does not exist, and no state is kept', async () => {
      const connectionA = await createChannelConnection(owner, {
        storeId: ctx.storeA.id,
        channelType: LOGIN_PLUGIN
      })
      const saved = jest.spyOn(app.get(ChannelOAuthStore, { strict: false }), 'saveState')
      try {
        // The same call from the store that owns the connection is accepted: the 404 below is the store, not the plugin
        const own = await api(app, ctx.adminA, ctx.storeA)
          .post(ApiRoutes.channels.oauthStart(LOGIN_PLUGIN))
          .send({ connectionId: connectionA.id })
        expect(own.status).toBe(200)
        saved.mockClear()
        const foreign = await api(app, ctx.adminB, ctx.storeB)
          .post(ApiRoutes.channels.oauthStart(LOGIN_PLUGIN))
          .send({ connectionId: connectionA.id })
        const missing = await api(app, ctx.adminB, ctx.storeB)
          .post(ApiRoutes.channels.oauthStart(LOGIN_PLUGIN))
          .send({ connectionId: randomUUID() })
        expect(foreign.status).toBe(404)
        expect(missing.status).toBe(404)
        expect((foreign.body as { error: unknown }).error).toEqual(
          (missing.body as { error: unknown }).error
        )
        expect(saved).not.toHaveBeenCalled()
      } finally {
        saved.mockRestore()
      }
      // The connection of the other store is as it was
      const row = await owner.channelConnection.findUniqueOrThrow({ where: { id: connectionA.id } })
      expect(row.storeId).toBe(ctx.storeA.id)
    })

    it('cannot be started or finished for a store the person does not belong to', async () => {
      const intruder = api(app, ctx.adminA, ctx.storeB)
      const start = await intruder.post(ApiRoutes.channels.oauthStart(LOGIN_PLUGIN))
      expect(start.status).toBe(403)
    })
  })

  describe('the directory of channels', () => {
    it('lists the connections of the store of the caller, with none of another store in it', async () => {
      const connectionA = await createChannelConnection(owner, {
        storeId: ctx.storeA.id,
        channelType: 'test_channel'
      })
      const connectionB = await createChannelConnection(owner, {
        storeId: ctx.storeB.id,
        channelType: 'test_channel'
      })

      const response = await api(app, ctx.adminA, ctx.storeA).get(ApiRoutes.channels.directory)

      expect(response.status).toBe(200)
      expect(JSON.stringify(response.body)).toContain(connectionA.id)
      expect(JSON.stringify(response.body)).not.toContain(connectionB.id)
    })

    it('is refused for a store the user does not belong to', async () => {
      const response = await anonymousApi(app)
        .get(ApiRoutes.channels.directory)
        .set('authorization', `Bearer ${ctx.adminB.token}`)
        .set(TenantHeaders.STORE_ID, ctx.storeA.id)

      expect(response.status).toBe(403)
    })
  })

  // The profile of a customer reads from several tables at once; none of them may reach across stores
  describe('the activity of a customer', () => {
    it('is not read, nor previewed for a merge, through a customer of another store', async () => {
      const mine = await createCustomer(owner, { storeId: ctx.storeA.id })
      const theirs = await createCustomer(owner, { storeId: ctx.storeB.id })
      await owner.customerNote.create({
        data: { customerId: theirs.id, authorId: ctx.adminB.id, content: 'secret note' }
      })
      const asA = () => api(app, ctx.adminA, ctx.storeA)

      const responses = await Promise.all([
        asA().get(ApiRoutes.customers.timeline(theirs.id)),
        asA().get(ApiRoutes.customers.orders(theirs.id)),
        asA().get(ApiRoutes.customers.conversations(theirs.id)),
        asA().get(ApiRoutes.customers.mergePreview(mine.id)).query({ absorbedId: theirs.id }),
        asA().get(ApiRoutes.customers.mergePreview(theirs.id)).query({ absorbedId: mine.id }),
        asA().put(ApiRoutes.customers.caution(theirs.id)).send({ reason: 'not mine to flag' }),
        asA().delete(ApiRoutes.customers.caution(theirs.id))
      ])

      for (const response of responses) {
        expect(response.status).toBe(404)
        expect(JSON.stringify(response.body)).not.toContain('secret note')
      }
      expect((await owner.customer.findUniqueOrThrow({ where: { id: theirs.id } })).isCaution).toBe(
        false
      )
    })
  })

  // The orders of a customer, in its list and in its timeline, are those of the store of the request: an
  // order of another store is not shown even when it names a customer of this one, and an order of this
  // store is not shown to the other
  describe('the orders of a customer', () => {
    it('are the ones of the store of the request, in the list, the figures and the timeline', async () => {
      const mine = await createCustomer(owner, { storeId: ctx.storeA.id })
      const theirs = await createCustomer(owner, { storeId: ctx.storeB.id })
      const make = (storeId: string, customerId: string, orderNumber: string, totalCents: number) =>
        owner.order.create({
          data: {
            storeId,
            customerId,
            orderNumber: `${prefix}-${orderNumber}`,
            status: 'CONFIRMED',
            subtotalCents: totalCents,
            totalCents,
            paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
            createdBy: storeId === ctx.storeA.id ? ctx.adminA.id : ctx.adminB.id
          },
          select: { id: true }
        })
      const own = await make(ctx.storeA.id, mine.id, 'own', 1000)
      // Names a customer of store A while belonging to store B
      const crossed = await make(ctx.storeB.id, mine.id, 'crossed', 777_000)
      const foreign = await make(ctx.storeB.id, theirs.id, 'foreign', 555_000)

      const list = await api(app, ctx.adminA, ctx.storeA).get(ApiRoutes.customers.orders(mine.id))
      const timeline = await api(app, ctx.adminA, ctx.storeA).get(
        ApiRoutes.customers.timeline(mine.id)
      )

      expect(list.status).toBe(200)
      const ids = (list.body as { data: { id: string }[] }).data.map(order => order.id)
      expect(ids).toEqual([own.id])
      // The figures add up the orders of the store only
      expect((list.body as { figures: { totalSpentCents: number } }).figures.totalSpentCents).toBe(
        1000
      )
      const entries = (timeline.body as { data: { type: string; id: string }[] }).data
      expect(entries.filter(entry => entry.type === 'order').map(entry => entry.id)).toEqual([
        own.id
      ])
      for (const hidden of [crossed.id, foreign.id]) {
        expect(JSON.stringify([list.body, timeline.body])).not.toContain(hidden)
      }
    })

    it('are not listed to a member who may not view orders, in the list or in the timeline', async () => {
      const mine = await createCustomer(owner, { storeId: ctx.storeA.id })
      await owner.order.create({
        data: {
          storeId: ctx.storeA.id,
          customerId: mine.id,
          orderNumber: `${prefix}-noperm`,
          subtotalCents: 10,
          totalCents: 10,
          paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
          createdBy: ctx.adminA.id
        }
      })
      const viewer = await actorWithPermissions(owner, app, {
        prefix,
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        name: 'customersOnlyOrders',
        permissions: [Permissions.CUSTOMERS_VIEW]
      })

      const list = await api(app, viewer, ctx.storeA).get(ApiRoutes.customers.orders(mine.id))
      const timeline = await api(app, viewer, ctx.storeA).get(ApiRoutes.customers.timeline(mine.id))

      expect(list.status).toBe(403)
      expect(timeline.status).toBe(200)
      expect(
        (timeline.body as { data: { type: string }[] }).data.filter(e => e.type === 'order')
      ).toEqual([])
    })
  })

  // The mark of attention and the reminder of a snooze belong to the conversation: another store neither
  // clears the mark by opening it, nor sets a reminder, nor sees the conversation in its list
  describe('the mark of attention of a conversation', () => {
    it('is not cleared, set or listed through another store', async () => {
      const { id } = await createConversationOf(owner, { storeId: ctx.storeA.id })
      await owner.conversation.update({
        where: { id },
        data: {
          attentionReason: 'snooze_woke',
          attentionAt: new Date(),
          attentionNote: 'private reminder'
        }
      })
      const asB = () => api(app, ctx.adminB, ctx.storeB)

      const opened = await asB().post(ApiRoutes.conversations.read(id))
      const snoozed = await asB()
        .post(ApiRoutes.conversations.snooze(id))
        .send({ until: new Date(Date.now() + 3_600_000).toISOString(), note: 'not mine' })
      const listed = await asB().get(ApiRoutes.conversations.list)

      expect(opened.status).toBe(404)
      expect(snoozed.status).toBe(404)
      expect(JSON.stringify(listed.body)).not.toContain('private reminder')
      const after = await owner.conversation.findUniqueOrThrow({
        where: { id },
        select: { status: true, snoozeNote: true, attentionReason: true, attentionNote: true }
      })
      expect(after).toEqual({
        status: ConversationStatus.OPEN,
        snoozeNote: null,
        attentionReason: 'snooze_woke',
        attentionNote: 'private reminder'
      })
    })
  })

  // The text under a file belongs to the message of its conversation: another store neither reads it from
  // the thread, nor finds it in a list, nor sends one of its own under a file of this store
  describe('the text under the files of a message', () => {
    it('is not read, listed or written through another store', async () => {
      const { id: conversationId } = await createConversationOf(owner, { storeId: ctx.storeA.id })
      const message = await owner.message.create({
        data: {
          storeId: ctx.storeA.id,
          conversationId,
          type: MessageType.IMAGE,
          content: 'private text under a file',
          authorType: 'agent'
        },
        select: { id: true }
      })
      const mediaId = randomUUID()
      await owner.media.create({
        data: {
          id: mediaId,
          storeId: ctx.storeA.id,
          messageId: message.id,
          purpose: 'message',
          key: `stores/${ctx.storeA.id}/messages/${mediaId}/a.png`,
          filename: 'a.png',
          contentType: 'image/png',
          fileSize: 10,
          status: 'clean',
          position: 0,
          caption: 'private text under a file'
        }
      })
      const asB = () => api(app, ctx.adminB, ctx.storeB)

      const thread = await asB().get(ApiRoutes.conversations.messages(conversationId))
      const list = await asB().get(ApiRoutes.conversations.list)
      const write = await asB()
        .post(ApiRoutes.messages.create)
        .send({
          type: MessageType.IMAGE,
          conversationId,
          mediaIds: [mediaId],
          captions: ['hijacked'],
          idempotencyKey: randomUUID()
        })

      // Even a text that failed and could be sent again is not reachable from another store
      await owner.message.update({
        where: { id: message.id },
        data: { deliveryStatus: 'sent', captionState: 'failed' }
      })
      const resend = await asB().post(ApiRoutes.messages.resendCaption(message.id))
      expect(resend.status).toBe(404)
      expect(
        (
          await owner.message.findUniqueOrThrow({
            where: { id: message.id },
            select: { captionState: true }
          })
        ).captionState
      ).toBe('failed')
      expect(thread.status).toBe(404)
      expect(JSON.stringify([thread.body, list.body])).not.toContain('private text under a file')
      expect(write.status).toBe(404)
      const after = await owner.media.findUniqueOrThrow({
        where: { id: mediaId },
        select: { caption: true, messageId: true }
      })
      expect(after).toEqual({ caption: 'private text under a file', messageId: message.id })
    })
  })

  // Who of the team is online comes from Redis, keyed by the store of the request
  describe('the presence of the team', () => {
    it('is answered for the store of the caller, with nobody of another store in it', async () => {
      const response = await api(app, ctx.adminA, ctx.storeA).get(ApiRoutes.presence.team)

      expect(response.status).toBe(200)
      expect(JSON.stringify(response.body)).not.toContain(ctx.adminB.id)
    })

    it('is refused for a store the user does not belong to', async () => {
      const response = await anonymousApi(app)
        .get(ApiRoutes.presence.team)
        .set('authorization', `Bearer ${ctx.adminB.token}`)
        .set(TenantHeaders.STORE_ID, ctx.storeA.id)

      expect(response.status).toBe(403)
    })
  })

  // Orders: the store of every query is the one of the header; the three notes belong to the members of that store who
  // may read orders, and nothing of them leaves through the label, an event or the plugin API (TDD_17 §8)
  describe('orders', () => {
    const asA = () => api(app, ctx.adminA, ctx.storeA)
    const asB = () => api(app, ctx.adminB, ctx.storeB)

    it('are not read, edited, moved, paid or decided through another store, and nothing of them changes', async () => {
      const theirs = await createOrder(owner, {
        storeId: ctx.storeB.id,
        customerNotes: 'their customer note',
        internalNotes: 'their care note',
        packingNotes: 'their packing note'
      })
      const before = await owner.order.findUniqueOrThrow({ where: { id: theirs.id } })

      const responses = await Promise.all([
        asA().get(ApiRoutes.orders.byId(theirs.id)),
        asA()
          .patch(ApiRoutes.orders.byId(theirs.id))
          .send({ packingNotes: 'hacked', internalNotes: 'hacked' }),
        asA().post(ApiRoutes.orders.status(theirs.id)).send({ status: 'CONFIRMED' }),
        asA().post(ApiRoutes.orders.confirm(theirs.id)).send({ via: 'call' }),
        asA().post(ApiRoutes.orders.cancel(theirs.id)).send({ cancellationReason: 'x' }),
        asA()
          .post(ApiRoutes.orders.payment(theirs.id))
          .send({ method: 'CASH', status: 'COMPLETED' }),
        asA().post(ApiRoutes.orders.priceApprovalApprove(theirs.id)).send({}),
        asA().post(ApiRoutes.orders.priceApprovalReject(theirs.id)).send({}),
        // The draft of a copy reads the old order: another store's is not there
        asA().get(ApiRoutes.orders.copy(theirs.id))
      ])

      for (const response of responses) {
        expect(response.status).toBe(404)
        expect(JSON.stringify(response.body)).not.toMatch(/their (customer|care|packing) note/)
      }
      expect(await owner.order.findUniqueOrThrow({ where: { id: theirs.id } })).toEqual(before)
    })

    it('are not confirmed in bulk through another store: the order is reported as not found and does not change', async () => {
      const theirs = await createOrder(owner, { storeId: ctx.storeB.id })
      const mine = await createOrder(owner, { storeId: ctx.storeA.id })
      const before = await owner.order.findUniqueOrThrow({ where: { id: theirs.id } })

      const response = await asA()
        .post(ApiRoutes.orders.confirmBulk)
        .send({ ids: [theirs.id, mine.id], via: 'call' })

      expect(response.status).toBe(200)
      expect(response.body).toEqual({
        succeeded: [mine.id],
        failed: [{ id: theirs.id, code: ErrorCodes.RESOURCE_NOT_FOUND }]
      })
      expect(await owner.order.findUniqueOrThrow({ where: { id: theirs.id } })).toEqual(before)
    })

    it('name the order they were copied from only inside their own store', async () => {
      const theirs = await createOrder(owner, { storeId: ctx.storeB.id })
      const mine = await createCustomer(owner, { storeId: ctx.storeA.id })
      const myProduct = await createProduct(owner, { storeId: ctx.storeA.id })
      await owner.product.update({ where: { id: myProduct.id }, data: { trackInventory: false } })

      const response = await asA()
        .post(ApiRoutes.orders.create)
        .send({
          customerId: mine.id,
          items: [{ productId: myProduct.id, quantity: 1 }],
          paymentMethod: 'CASH',
          recipientPhones: ['71234567'],
          copiedFromOrderId: theirs.id
        })

      expect(response.status).toBe(404)
      expect(response.body).toMatchObject({ error: { code: ErrorCodes.RESOURCE_NOT_FOUND } })
      // The answer of a source of another store is the one of a source that does not exist
      const none = await asA()
        .post(ApiRoutes.orders.create)
        .send({
          customerId: mine.id,
          items: [{ productId: myProduct.id, quantity: 1 }],
          paymentMethod: 'CASH',
          recipientPhones: ['71234567'],
          copiedFromOrderId: randomUUID()
        })
      expect(none.status).toBe(404)
      expect((none.body as { error: unknown }).error).toMatchObject({
        code: ErrorCodes.RESOURCE_NOT_FOUND
      })
      expect(await owner.order.count({ where: { customerId: mine.id } })).toBe(0)
    })

    it('do not take the store from the body: another store named there is refused, and what is made lands in the header store', async () => {
      const customer = await createCustomer(owner, { storeId: ctx.storeA.id })
      const product = await createProduct(owner, { storeId: ctx.storeA.id })
      await owner.product.update({ where: { id: product.id }, data: { trackInventory: false } })
      const body = {
        customerId: customer.id,
        items: [{ productId: product.id, quantity: 1 }],
        paymentMethod: 'CASH',
        recipientPhones: ['71234567']
      }
      const orders = () => owner.order.count({ where: { customerId: customer.id } })

      const named = await asA()
        .post(ApiRoutes.orders.create)
        .send({ ...body, storeId: ctx.storeB.id })
      expect(named.status).toBe(400)
      expect(await orders()).toBe(0)

      const made = await asA().post(ApiRoutes.orders.create).send(body)
      expect(made.status).toBe(201)
      const row = await owner.order.findFirstOrThrow({ where: { customerId: customer.id } })
      expect(row.storeId).toBe(ctx.storeA.id)
    })

    it('are not made for a customer, a product or a conversation of another store', async () => {
      const mine = await createCustomer(owner, { storeId: ctx.storeA.id })
      const theirCustomer = await createCustomer(owner, { storeId: ctx.storeB.id })
      const theirProduct = await createProduct(owner, { storeId: ctx.storeB.id })
      const myProduct = await createProduct(owner, { storeId: ctx.storeA.id })
      const theirConversation = await createConversationOf(owner, { storeId: ctx.storeB.id })
      const base = { paymentMethod: 'CASH', recipientPhones: ['71234567'] }

      const responses = await Promise.all([
        asA()
          .post(ApiRoutes.orders.create)
          .send({
            ...base,
            customerId: theirCustomer.id,
            items: [{ productId: myProduct.id, quantity: 1 }]
          }),
        asA()
          .post(ApiRoutes.orders.create)
          .send({
            ...base,
            customerId: mine.id,
            items: [{ productId: theirProduct.id, quantity: 1 }]
          }),
        asA()
          .post(ApiRoutes.orders.create)
          .send({
            ...base,
            customerId: mine.id,
            conversationId: theirConversation.id,
            items: [{ productId: myProduct.id, quantity: 1 }]
          })
      ])

      for (const response of responses) expect(response.status).toBe(404)
      expect(
        await owner.order.count({ where: { customerId: { in: [mine.id, theirCustomer.id] } } })
      ).toBe(0)
    })

    it('are listed by the store of the header, with the scheduled delivery filters inside it', async () => {
      const day = new Date('2026-12-24T00:00:00Z')
      const mine = await createOrder(owner, { storeId: ctx.storeA.id, scheduledDeliveryDate: day })
      const theirs = await createOrder(owner, {
        storeId: ctx.storeB.id,
        scheduledDeliveryDate: day
      })

      const filtered = await asA().get(
        `${ApiRoutes.orders.list}?scheduledDeliveryFrom=2026-12-24&scheduledDeliveryTo=2026-12-24`
      )
      const claiming = await asA().get(`${ApiRoutes.orders.list}?customerId=${randomUUID()}`)

      expect(filtered.status).toBe(200)
      const ids = (filtered.body as { data: { id: string }[] }).data.map(row => row.id)
      expect(ids).toContain(mine.id)
      expect(ids).not.toContain(theirs.id)
      expect((claiming.body as { data: unknown[] }).data).toEqual([])
      expect((await asB().get(ApiRoutes.orders.list)).status).toBe(200)
    })

    it('keep the allocations of the order in its own store: stock of another store is never reserved for it', async () => {
      const customer = await createCustomer(owner, { storeId: ctx.storeA.id })
      const product = await createProduct(owner, { storeId: ctx.storeA.id })
      const outsider = await createProduct(owner, { storeId: ctx.storeB.id })
      const body = {
        customerId: customer.id,
        paymentMethod: 'CASH',
        recipientPhones: ['71234567']
      }

      // No stock in store A for its product: refused, and the stock of store B is not touched
      const refused = await asA()
        .post(ApiRoutes.orders.create)
        .send({ ...body, items: [{ productId: product.id, quantity: 1 }] })
      expect(refused.status).toBe(409)
      expect(
        await owner.orderItemAllocation.count({
          where: { orderItem: { order: { customerId: customer.id } } }
        })
      ).toBe(0)
      expect(await owner.inventoryLevel.count({ where: { productId: outsider.id } })).toBe(0)
    })

    it('hide the notes from a member who cannot read orders: 403 and no note in the answer', async () => {
      const made = await createOrder(owner, {
        storeId: ctx.storeA.id,
        customerNotes: 'a customer note',
        internalNotes: 'a customer care note',
        packingNotes: 'a packing note'
      })
      const stranger = await actorWithPermissions(owner, app, {
        prefix,
        name: 'no-orders',
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        permissions: [
          Permissions.CUSTOMERS_VIEW,
          Permissions.ORDERS_CREATE,
          Permissions.ORDERS_EDIT
        ]
      })
      const denied = await api(app, stranger, ctx.storeA).get(ApiRoutes.orders.byId(made.id))
      const listed = await api(app, stranger, ctx.storeA).get(ApiRoutes.orders.list)
      const edited = await api(app, stranger, ctx.storeA)
        .patch(ApiRoutes.orders.byId(made.id))
        .send({ customerNotes: 'edited' })

      expect(denied.status).toBe(403)
      expect(listed.status).toBe(403)
      for (const response of [denied, listed, edited]) {
        expect(JSON.stringify(response.body)).not.toMatch(/care note|packing note/)
      }
      expect(edited.status).toBe(200)
      expect('internalNotes' in (edited.body as object)).toBe(false)
      // The member who may read orders reads all three
      const reader = await asA().get(ApiRoutes.orders.byId(made.id))
      expect(reader.body).toMatchObject({
        internalNotes: 'a customer care note',
        packingNotes: 'a packing note'
      })
    })
  })

  describe('the reception of returns by scanner', () => {
    it('scans, deletes and completes nothing of another store, and a foreign guide matches nothing', async () => {
      const foreign = await createShipment(owner, {
        storeId: ctx.storeB.id,
        status: ShipmentStatus.RETURNING
      })
      const guide = (await owner.shipment.findUniqueOrThrow({ where: { id: foreign.id } }))
        .guideNumber as string
      const foreignBatch = await owner.returnReceptionBatch.create({
        data: { storeId: ctx.storeB.id, createdBy: 'system' },
        select: { id: true }
      })
      const foreignItem = await owner.returnReceptionItem.create({
        data: {
          storeId: ctx.storeB.id,
          batchId: foreignBatch.id,
          shipmentId: foreign.id,
          reason: 'DELIVERY_FAILED'
        },
        select: { id: true }
      })
      const asA = () => api(app, ctx.adminA, ctx.storeA)
      const mine = await asA().post(ApiRoutes.returns.reception.batches)
      const myBatch = (mine.body as { id: string }).id

      // The code of a package of store B finds nothing in a batch of store A
      const scanned = await asA()
        .post(ApiRoutes.returns.reception.scan(myBatch))
        .send({ code: guide })
      expect(scanned.body).toEqual({ result: 'not_found' })
      // A batch of store B is not scanned into, nor completed, nor emptied, from store A
      for (const response of [
        await asA().post(ApiRoutes.returns.reception.scan(foreignBatch.id)).send({ code: guide }),
        await asA().post(ApiRoutes.returns.reception.complete(foreignBatch.id)),
        await asA().delete(ApiRoutes.returns.reception.itemById(foreignBatch.id, foreignItem.id))
      ]) {
        expect(response.status).toBe(404)
      }
      // An item of store B named through a batch of store A is not found either
      expect(
        (await asA().delete(ApiRoutes.returns.reception.itemById(myBatch, foreignItem.id))).status
      ).toBe(404)
      expect(await owner.returnReceptionItem.count({ where: { id: foreignItem.id } })).toBe(1)
      expect(
        (await owner.returnReceptionBatch.findUniqueOrThrow({ where: { id: foreignBatch.id } }))
          .status
      ).toBe('draft')
    })
  })
})
