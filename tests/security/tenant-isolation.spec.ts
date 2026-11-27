import { createHash, randomInt, randomUUID } from 'node:crypto'
import { gzipSync } from 'node:zlib'

import type { INestApplication } from '@nestjs/common'
import supertest from 'supertest'

import { ChannelOAuthConfig } from '@platform/channels/connections'
import {
  AnalyticsEventNames,
  AnalyticsMetrics,
  MetricDimensions,
  ReportFrequency,
  ReportMetrics
} from '@platform/core/analytics'
import { API_PREFIX, ApiRoutes, PluginApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { Permissions, RoleNames, TenantHeaders } from '@platform/core/auth'
import { ConsentPurposes } from '@platform/core/compliance'
import { signUnsubscribeToken, UnsubscribeScopes } from '@platform/core/crypto'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  CarrierId,
  ChannelIds,
  CodStatus,
  CountStatus,
  ConversationStatus,
  DeliveryStatus,
  DsrStatus,
  DsrType,
  FinanceSourceType,
  FinanceTransactionKind,
  InventoryAdjustmentReason,
  InventoryMovementType,
  InvitationStatus,
  JournalEntryType,
  MembershipStatus,
  MessageType,
  OrderConfirmationChannel,
  OrderMessageKind,
  OrderMessageNotSentReasons,
  OrderMessageRoutes,
  OrderMessageTriggers,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  PLUGIN_API_KEY_TOKEN_PREFIX,
  PluginCatalogTypes,
  PluginPricingModels,
  PluginStatus,
  PurchaseOrderStatus,
  RemittanceStatus,
  RoutingActionTypes,
  PickupStatus,
  ShipmentStatus,
  ShippingPlugin,
  TransferStatus
} from '@platform/core/domain'
import { ErrorCodes, HttpStatusCodes } from '@platform/core/errors'
import { Events } from '@platform/core/events'
import { Locales } from '@platform/core/i18n'
import {
  NotificationSeverity,
  notificationMessageKey,
  NotificationTypes,
  UNSUBSCRIBE_VERIFICATION_KEYS
} from '@platform/core/notifications'
import {
  ExportFormats,
  ExportStatus,
  ExportTypes,
  JobNames,
  QueueNames
} from '@platform/core/queues'
import { StorageKeys } from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'
import { PluginRegistry } from '@platform/plugins/runtime'
import { PluginScopes } from '@platform/plugins/sdk'

import { ChannelOAuthStore } from '../../apps/api/src/modules/channels/oauth/channel-oauth.store'
import { WebhookDispatcher } from '../../apps/api/src/modules/tenant-webhooks/webhook-dispatcher'
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
  createFinanceFixture,
  createPeriod,
  day,
  createWarehouse,
  linkWarehouse,
  postTestEntry,
  simpleEntry,
  type FinanceFixture,
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
  createPluginKey,
  createInventoryLevel,
  createSnippet,
  createApiKey,
  createWebhook,
  createTag,
  resetStoreSettings,
  customerOfIdentity,
  customerOfFiscalData,
  createCustomerFiscalData,
  customerOfConsent,
  createConsentRecord,
  createDataSubjectRequest,
  DSR_FIXTURE_NOTE,
  survivorOfMerge,
  dropCachedSettings
} from '../builders'
import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { allDirectoryRows } from '../helpers/directory'
import { anonymousApi, api, apiWithoutStore } from '../helpers/http'
import {
  type IsolationCheck,
  isolationChecks,
  type IsolationResource,
  type IsolationScene
} from '../helpers/isolation'
import { queueOf } from '../helpers/queue'

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

// The books of an organization (TDD_18): set up once per organization of the run, as the owner of the database, so that the
// resources of the ledger have something to read. The accounts are the fixture's, the entries are written the way the posting
// service writes them.
const financeBooks = new Map<string, Promise<FinanceFixture>>()
function booksOf(owner: OwnerClient, organizationId: string): Promise<FinanceFixture> {
  const known = financeBooks.get(organizationId)
  if (known !== undefined) return known
  const created = createFinanceFixture(owner, organizationId)
  financeBooks.set(organizationId, created)
  return created
}
async function booksOfStore(owner: OwnerClient, storeId: string): Promise<FinanceFixture> {
  return booksOf(owner, await organizationOfStore(owner, storeId))
}
// A fiscal document of a store, as the owner: the row a sale makes, with no sealed receiver (the views read it as an empty one)
async function createFiscalDocumentRow(
  owner: OwnerClient,
  storeId: string
): Promise<{ id: string }> {
  const organizationId = await organizationOfStore(owner, storeId)
  await ensureFiscalIssuer(owner, organizationId)
  const order = await createOrder(owner, { storeId })
  const row = await owner.fiscalDocument.create({
    data: {
      organizationId,
      storeId,
      orderId: order.id,
      sequenceNumber: randomInt(1_000_000, 2_000_000_000),
      documentType: 'pending',
      status: 'queued',
      providerId: 'simulator',
      environment: 'sandbox',
      issuerSnapshot: {},
      linesSnapshot: { lines: [] },
      receiverEncrypted: Buffer.from('isolation-fixture'),
      totalCents: 1999,
      taxCents: 0
    },
    select: { id: true }
  })
  return row
}
// The document a delivery of the suite belongs to: a delivery is reached by the route of its document
const documentOfDelivery = new Map<string, string>()
// The fiscal issuer of an organization (TDD_18 §8.2), as the owner: the simulator's, with no credentials (the isolation cases do not
// submit anything)
async function ensureFiscalIssuer(owner: OwnerClient, organizationId: string): Promise<void> {
  await owner.fiscalIssuer.upsert({
    where: { organizationId },
    create: {
      organizationId,
      providerId: 'simulator',
      legalName: 'iso-issuer',
      taxId: 'ISO-TAX',
      address: { line1: 'x' },
      environment: 'sandbox'
    },
    update: {}
  })
}
// A supplier of an organization, and a draft purchase order of it for a warehouse of the organization (TDD_18 §2.7), as the owner
async function createSupplierOf(
  owner: OwnerClient,
  organizationId: string
): Promise<{ id: string }> {
  return owner.supplier.create({
    data: { organizationId, name: `iso-supplier-${randomUUID().slice(0, 8)}` },
    select: { id: true }
  })
}
async function createPurchaseOrderOf(
  owner: OwnerClient,
  organizationId: string,
  line?: { storeId: string; productId: string }
): Promise<{ id: string }> {
  await booksOf(owner, organizationId)
  const supplier = await createSupplierOf(owner, organizationId)
  const warehouse = await createWarehouse(owner, { organizationId })
  const id = randomUUID()
  await owner.purchaseOrder.create({
    data: {
      id,
      organizationId,
      number: `ISO-${id.slice(0, 8)}`,
      supplierId: supplier.id,
      warehouseId: warehouse.id,
      status: PurchaseOrderStatus.DRAFT,
      clientKey: `iso-${id}`,
      createdBy: 'isolation-suite'
    }
  })
  if (line !== undefined) {
    await owner.purchaseOrderLine.create({
      data: {
        organizationId,
        storeId: line.storeId,
        purchaseOrderId: id,
        lineNo: 1,
        productId: line.productId,
        quantity: 2,
        unitCostCents: 100
      }
    })
  }
  return { id }
}
// The supplier a payment of the suite was made to: the payments are read in the list of their supplier
const supplierOfPayment = new Map<string, string>()
const paymentOfReturn = new Map<string, string>()
const importOfGroupLine = new Map<string, string>()
// The order a row of the purchases belongs to: a line, a receipt and the line of a receipt are reached through their order
const orderOfPurchaseRow = new Map<string, string>()
const purchaseOrderPathOf = (build: (id: string) => string) => (id: string) =>
  build(orderOfPurchaseRow.get(id) ?? randomUUID())
// A purchase order of the organization of the store with a line of the store, a receipt of one unit of it and the line of that receipt
async function createReceiptOf(
  owner: OwnerClient,
  storeId: string
): Promise<{ orderLineId: string; receiptId: string; receiptLineId: string }> {
  const organizationId = await organizationOfStore(owner, storeId)
  const books = await booksOf(owner, organizationId)
  const product = await createProduct(owner, { storeId })
  const order = await createPurchaseOrderOf(owner, organizationId, {
    storeId,
    productId: product.id
  })
  const purchase = await owner.purchaseOrder.findUniqueOrThrow({
    where: { id: order.id },
    select: { supplierId: true }
  })
  const orderLine = await owner.purchaseOrderLine.findFirstOrThrow({
    where: { purchaseOrderId: order.id },
    select: { id: true }
  })
  const receiptId = randomUUID()
  const entry = await postTestEntry(
    owner,
    simpleEntry(books, 1000, {
      type: JournalEntryType.PURCHASE_RECEIPT,
      sourceType: FinanceSourceType.PURCHASE_RECEIPT,
      sourceId: receiptId
    })
  )
  await owner.purchaseReceipt.create({
    data: {
      id: receiptId,
      organizationId,
      purchaseOrderId: order.id,
      supplierId: purchase.supplierId,
      receivedOn: day(FINANCE_ENTRY_DATE),
      dueOn: day(FINANCE_ENTRY_DATE),
      taxCreditable: false,
      subtotalCents: 1000,
      taxCents: 0,
      totalCents: 1000,
      clientKey: `iso-${receiptId}`,
      entryId: entry.id,
      createdBy: 'isolation-suite'
    }
  })
  const receiptLineId = randomUUID()
  await owner.purchaseReceiptLine.create({
    data: {
      id: receiptLineId,
      organizationId,
      storeId,
      receiptId,
      orderLineId: orderLine.id,
      quantity: 1,
      unitCostCents: 1000,
      subtotalCents: 1000,
      taxCents: 0,
      movementId: 'isolation-movement'
    }
  })
  for (const id of [orderLine.id, receiptId, receiptLineId]) orderOfPurchaseRow.set(id, order.id)
  return { orderLineId: orderLine.id, receiptId, receiptLineId }
}
// What the rows reached through their order are checked with (see the cases below)
const purchaseRowChecks: Omit<IsolationResource, 'name' | 'create'> = {
  scope: 'organization',
  readPath: purchaseOrderPathOf(ApiRoutes.purchaseOrders.byId),
  modify: {
    path: purchaseOrderPathOf(ApiRoutes.purchaseOrders.update),
    body: { notes: 'hacked' }
  },
  untouched: async (owner, id) =>
    (
      await owner.purchaseOrder.findUnique({
        where: { id: orderOfPurchaseRow.get(id) ?? randomUUID() },
        select: { notes: true }
      })
    )?.notes !== 'hacked'
}
// A statement of the cash account of an organization with one line, as the import writes it: the file is a finance file of the store
// and the line carries its hash (TDD_18 §4.4)
async function bankStatementOf(
  owner: OwnerClient,
  storeId: string,
  cents = -700
): Promise<{ organizationId: string; accountId: string; importId: string; lineId: string }> {
  const books = await booksOfStore(owner, storeId)
  const mediaId = randomUUID()
  await owner.media.create({
    data: {
      id: mediaId,
      storeId,
      purpose: 'finance_document',
      key: `${prefix}/bank-statement/${mediaId}`,
      filename: 'statement.csv',
      contentType: 'text/csv',
      fileSize: 10,
      status: 'clean'
    }
  })
  const imported = await owner.bankStatementImport.create({
    data: {
      organizationId: books.organizationId,
      accountId: books.accounts.cash,
      mediaId,
      lineCount: 1,
      newLineCount: 1,
      firstDay: day(FINANCE_ENTRY_DATE),
      lastDay: day(FINANCE_ENTRY_DATE),
      createdBy: 'isolation-suite'
    },
    select: { id: true }
  })
  const line = await owner.bankStatementLine.create({
    data: {
      organizationId: books.organizationId,
      importId: imported.id,
      accountId: books.accounts.cash,
      lineNo: 2,
      postedOn: day(FINANCE_ENTRY_DATE),
      amountCents: cents,
      lineHash: randomUUID().replaceAll('-', '').padEnd(64, '0')
    },
    select: { id: true }
  })
  return {
    organizationId: books.organizationId,
    accountId: books.accounts.cash,
    importId: imported.id,
    lineId: line.id
  }
}

// Each call asks for a period of a year no other has taken, so that every row is one more
let periodYear = 2100
const nextPeriodYear = (): number => (periodYear += 1)
let openedYear = 2150
const nextOpenedYear = (): number => (openedYear += 1)
const FINANCE_ENTRY_DATE = '2026-11-10'
// What the one-row-per-organization resources of the books put in a row of an organization, to tell two organizations apart
const FINANCE_MARKERS = {
  A: { start: '2026-01-01', cents: 111 },
  B: { start: '2026-01-02', cents: 222 }
} as const
// One entry of the organization of the store, on two accounts and with a memo of its own and an amount no other case posts, so that
// the report cases tell two organizations apart without touching the sums the other cases read
async function postMarkedEntry(owner: OwnerClient, storeId: string, marker: string): Promise<void> {
  const books = await booksOfStore(owner, storeId)
  const label = `${REPORT_MARKER_PREFIX}${marker}`
  const cents = marker === 'A' ? 333 : 444
  const account = async (type: string, normalSide: string) =>
    (
      await owner.ledgerAccount.create({
        data: {
          organizationId: books.organizationId,
          code: `M${randomUUID().slice(0, 8)}`,
          name: label,
          type,
          normalSide
        },
        select: { id: true }
      })
    ).id
  await postTestEntry(owner, {
    organizationId: books.organizationId,
    periodId: books.periodId,
    memo: label,
    lines: [
      { accountId: await account('expense', 'debit'), debitCents: cents },
      { accountId: await account('liability', 'credit'), creditCents: cents }
    ]
  })
}
const REPORT_MARKER_PREFIX = 'Report marker '
const reportMarkerOf = (text: string | null | undefined): string | null =>
  text?.startsWith(REPORT_MARKER_PREFIX) === true ? text.slice(REPORT_MARKER_PREFIX.length) : null
let financeBooksA: FinanceFixture | null = null

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
  status: CountStatus,
  // A count of the whole warehouse (null) or limited to the store
  limitedToStore = false
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
      ...(limitedToStore ? { storeId } : {}),
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

// The events of the search (`analytics_events`): the report of what was searched reads the zero-result texts of the catalog, and a
// text of another store must never reach it. The marker is the text of the only event the store holds.
async function writeSearchMarker(
  owner: OwnerClient,
  storeId: string,
  marker: string
): Promise<void> {
  await owner.analyticsEvent.deleteMany({ where: { storeId } })
  await owner.analyticsEvent.create({
    data: {
      storeId,
      event: AnalyticsEventNames.SEARCH_PERFORMED,
      data: {
        queryHash: createHash('sha256').update(marker).digest('hex').slice(0, 16),
        scope: 'products',
        resultCount: 0,
        durationMs: 1,
        query: marker
      },
      date: new Date(),
      eventKey: randomUUID()
    }
  })
}

function searchMarkerIn(body: unknown): string | null {
  const queries = (body as { zeroResultQueries?: { query: string }[] }).zeroResultQueries ?? []
  return queries.length === 1 ? (queries[0]?.query ?? null) : null
}

// The connection each row of the guide balance was made under: the routes of the ledger name the connection and the row
const connectionOfGuideMovement = new Map<string, string>()
const connectionOfBenefitPeriod = new Map<string, string>()

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
  // The erasure of a customer (Step 7.2) is a second way to change the same model: irreversible, so a request from another store
  // must be a 404 and leave the customer as it was (the case above covers its read, list, update and creation)
  {
    name: 'customer',
    create: createCustomer,
    modify: { path: ApiRoutes.customers.erasure, method: 'post', body: {} },
    untouched: async (owner, id) =>
      (await owner.customer.findUnique({ where: { id }, select: { erasedAt: true } }))?.erasedAt ===
      null
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
  // The consents of a customer are read and written through the customer (`GET` and `POST /compliance/consent`): a stranger
  // is a 404 on the customer, and a refused withdrawal must leave no new row behind. An id the suite made up (a row that does not
  // exist) is asked for as a customer: the answer must be the same 404
  {
    name: 'consentRecord',
    create: createConsentRecord,
    readPath: id => `${ApiRoutes.compliance.consent}?customerId=${customerOfConsent.get(id) ?? id}`,
    modify: {
      path: () => ApiRoutes.compliance.consent,
      method: 'post',
      body: id => ({
        customerId: customerOfConsent.get(id) ?? id,
        purpose: ConsentPurposes.ORDER_MESSAGES,
        granted: false
      })
    },
    untouched: async (owner, id) =>
      (await owner.consentRecord.count({ where: { customerId: customerOfConsent.get(id) } })) === 1
  },
  // The fiscal data of a customer (Step 4B.7b-3): personal and tax data, reached through its customer by the route that changes it. A
  // request from another store names a customer it does not have: a 404, and the row stays as it was.
  {
    name: 'customerFiscalData',
    create: createCustomerFiscalData,
    modify: {
      path: id => ApiRoutes.fiscal.customerData.put(customerOfFiscalData.get(id) ?? ''),
      method: 'put',
      body: { taxId: 'hacked' }
    },
    untouched: async (owner, id) =>
      (await owner.customerFiscalData.findUnique({ where: { id }, select: { updatedBy: true } }))
        ?.updatedBy === 'isolation-fixture'
  },
  // A request for the data of a person (Step 7.2-H1b): the review queue of the store. It is read by its id, and the one route of the suite
  // that changes it is the approval; the rejection and the cancellation have their own cases in `describe('data subject requests')`.
  {
    name: 'dataSubjectRequest',
    create: createDataSubjectRequest,
    readPath: id => ApiRoutes.compliance.dsrById(id),
    listPath: ApiRoutes.compliance.dsr,
    modify: {
      path: id => ApiRoutes.compliance.dsrApprove(id),
      method: 'post',
      body: { confirm: true, reason: 'isolation-suite' }
    },
    untouched: async (owner, id) => {
      const row = await owner.dataSubjectRequest.findUnique({
        where: { id },
        select: { notes: true, status: true }
      })
      return row?.notes === DSR_FIXTURE_NOTE && row.status === String(DsrStatus.MANUAL_REVIEW)
    }
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
  // The balance of prepaid guides and the refund benefit of a connection (Step 4.16). Every route names the connection of the
  // store: another store's connection is a 404 whatever the row asked for, and the ledger is never changed by a refused request.
  {
    name: 'carrierGuideMovement',
    create: async (owner, input) => {
      const connection = await createCarrierConnection(owner, { storeId: input.storeId })
      const row = await owner.carrierGuideMovement.create({
        data: {
          storeId: input.storeId,
          connectionId: connection.id,
          kind: 'purchase',
          guidesDelta: 10,
          costCentsDelta: 800,
          paidQuantity: 10,
          giftQuantity: 0,
          createdBy: 'system'
        },
        select: { id: true }
      })
      connectionOfGuideMovement.set(row.id, connection.id)
      return row
    },
    readPath: id =>
      ApiRoutes.carriers.guideMovements(connectionOfGuideMovement.get(id) ?? randomUUID()),
    modify: {
      path: id =>
        ApiRoutes.carriers.guidePurchaseVoid(connectionOfGuideMovement.get(id) ?? randomUUID(), id),
      method: 'post',
      body: { note: 'hacked' }
    },
    untouched: async (owner, id) =>
      (await owner.carrierGuideMovement.count({ where: { voidsMovementId: id } })) === 0
  },
  // The connection is the id of its policy
  {
    name: 'carrierGuidePolicy',
    create: async (owner, input) => {
      const connection = await createCarrierConnection(owner, { storeId: input.storeId })
      await owner.carrierGuidePolicy.create({
        data: { storeId: input.storeId, connectionId: connection.id, periodAnchor: '2026-11-01' }
      })
      return { id: connection.id }
    },
    readPath: ApiRoutes.carriers.guidePolicy,
    modify: {
      path: ApiRoutes.carriers.guidePolicy,
      method: 'put',
      body: {
        balanceEnabled: true,
        benefitEnabled: true,
        warnOnEmptyBalance: true,
        lowBalanceThreshold: null,
        periodKind: 'fixed_days',
        periodDays: 15,
        periodAnchor: '2026-11-01',
        thresholdBps: 1000,
        warnAtBps: 8000,
        base: 'delivered',
        returnStatuses: ['returned'],
        refundRule: 'at_period_close',
        lossRule: 'from_crossing'
      }
    },
    untouched: async (owner, id) =>
      (
        await owner.carrierGuidePolicy.findUnique({
          where: { connectionId: id },
          select: { balanceEnabled: true }
        })
      )?.balanceEnabled === false
  },
  // A judged period is only read (the daily close of the worker writes it): the history of a connection of another store is a 404
  {
    name: 'carrierBenefitPeriod',
    create: async (owner, input) => {
      const connection = await createCarrierConnection(owner, { storeId: input.storeId })
      const row = await owner.carrierBenefitPeriod.create({
        data: {
          storeId: input.storeId,
          connectionId: connection.id,
          periodStart: new Date('2026-11-01T00:00:00Z'),
          periodEnd: new Date('2026-11-16T00:00:00Z'),
          baseCount: 10,
          returnCount: 0,
          rateBps: 0,
          state: 'in_force',
          refundedCount: 0
        },
        select: { id: true }
      })
      connectionOfBenefitPeriod.set(row.id, connection.id)
      return row
    },
    readPath: id =>
      ApiRoutes.carriers.benefitPeriods(connectionOfBenefitPeriod.get(id) ?? randomUUID()),
    untouched: async (owner, id) =>
      (await owner.carrierBenefitPeriod.count({ where: { id } })) === 1
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
  {
    name: 'analyticsEvent',
    create: async (owner, input) => {
      await writeSearchMarker(owner, input.storeId, 'unset')
      return { id: input.storeId }
    },
    readPath: () => ApiRoutes.analytics.search,
    own: {
      set: (owner, storeId, marker) => writeSearchMarker(owner, storeId, marker),
      markerIn: searchMarkerIn
    },
    untouched: async (owner, id) =>
      (await owner.analyticsEvent.count({ where: { storeId: id } })) > 0
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
  // A private plugin belongs to the organization that registered it (D10): every store of it sees it, another organization
  // never does, and one id answers the same for a plugin that is not there
  {
    name: 'plugin',
    create: async (owner, { storeId }) => {
      const id = `iso-${randomUUID().slice(0, 12)}`
      await owner.plugin.create({
        data: {
          id,
          name: 'Isolation plugin',
          authorName: 'suite',
          authorEmail: 'suite@example.invalid',
          type: PluginCatalogTypes.INTEGRATION,
          manifest: {},
          pricingModel: PluginPricingModels.FREE,
          status: PluginStatus.APPROVED,
          organizationId: await organizationOfStore(owner, storeId)
        }
      })
      return { id }
    },
    scope: 'organization',
    readPath: ApiRoutes.plugins.byId,
    listPath: ApiRoutes.plugins.available,
    // The only route that changes the row of a plugin is its deletion (a newer manifest is covered by "a private plugin" below): with
    // no name typed it must be refused for a stranger exactly as for a plugin that is not there
    modify: { path: ApiRoutes.plugins.byId, method: 'delete', body: {} },
    untouched: async (owner, id) =>
      (await owner.plugin.findUnique({ where: { id }, select: { name: true } }))?.name ===
      'Isolation plugin'
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
  // The books of the organization (TDD_18 §2.1): every store of it reaches them with the permission it holds there, another
  // organization never does. The settings, the role and payment maps, the balances and the failed postings are one set per
  // organization (the checks of a row of its own, read through the store of the request); the chart, the periods and the
  // journal are rows reached by id.
  {
    name: 'financeSettings',
    create: async (owner, { storeId }) => {
      await booksOfStore(owner, storeId)
      return { id: storeId }
    },
    scope: 'organization',
    readPath: () => ApiRoutes.finance.settings,
    own: {
      set: async (owner, storeId, marker) => {
        const marked = marker === 'A' ? FINANCE_MARKERS.A : FINANCE_MARKERS.B
        await owner.financeSettings.update({
          where: { organizationId: await organizationOfStore(owner, storeId) },
          data: { accountingStartDate: new Date(`${marked.start}T00:00:00Z`) }
        })
      },
      markerIn: body => {
        const start = (body as { accountingStartDate?: string }).accountingStartDate
        return start === FINANCE_MARKERS.A.start
          ? 'A'
          : start === FINANCE_MARKERS.B.start
            ? 'B'
            : null
      }
    },
    modify: { path: () => ApiRoutes.finance.settings, body: { recognizeSaleOn: 'shipped' } },
    untouched: async (owner, storeId) =>
      (
        await owner.financeSettings.findUniqueOrThrow({
          where: { organizationId: await organizationOfStore(owner, storeId) },
          select: { recognizeSaleOn: true }
        })
      ).recognizeSaleOn === 'delivered'
  },
  {
    name: 'ledgerAccount',
    create: async (owner, { storeId }) => {
      const organizationId = await organizationOfStore(owner, storeId)
      await booksOf(owner, organizationId)
      return {
        id: (
          await owner.ledgerAccount.create({
            data: {
              organizationId,
              code: `L${randomUUID().slice(0, 8)}`,
              name: 'Isolation account',
              type: 'expense',
              normalSide: 'debit'
            },
            select: { id: true }
          })
        ).id
      }
    },
    scope: 'organization',
    readPath: ApiRoutes.finance.accounts.byId,
    listPath: ApiRoutes.finance.accounts.list,
    modify: { path: ApiRoutes.finance.accounts.byId, body: { name: 'hacked' } },
    untouched: async (owner, id) =>
      (await owner.ledgerAccount.findUnique({ where: { id }, select: { name: true } }))?.name !==
      'hacked',
    creation: {
      path: ApiRoutes.finance.accounts.create,
      body: name => ({ code: `C${randomUUID().slice(0, 8)}`, name, type: 'expense' }),
      strict: true,
      countIn: async (owner, storeId) =>
        owner.ledgerAccount.count({
          where: { organizationId: await organizationOfStore(owner, storeId) }
        }),
      storeOf: async (owner, id) =>
        (await owner.ledgerAccount.findUnique({ where: { id }, select: { organizationId: true } }))
          ?.organizationId ?? null
    }
  },
  // The role map is one set per organization: the marker is which role is mapped
  {
    name: 'accountRoleMapping',
    create: async (owner, { storeId }) => {
      await booksOfStore(owner, storeId)
      return { id: storeId }
    },
    scope: 'organization',
    readPath: () => ApiRoutes.finance.accountRoles.list,
    own: {
      set: async (owner, storeId, marker) => {
        const organizationId = await organizationOfStore(owner, storeId)
        const books = await booksOf(owner, organizationId)
        await owner.accountRoleMapping.deleteMany({ where: { organizationId } })
        await owner.accountRoleMapping.create({
          data:
            marker === 'A'
              ? { organizationId, role: 'cash_default', accountId: books.accounts.cash }
              : { organizationId, role: 'bank_default', accountId: books.accounts.bank }
        })
      },
      markerIn: body => {
        const roles = (body as { role: string }[]).map(row => row.role)
        return roles.includes('cash_default') ? 'A' : roles.includes('bank_default') ? 'B' : null
      }
    },
    untouched: () => Promise.resolve(true)
  },
  {
    name: 'paymentMethodAccount',
    create: async (owner, { storeId }) => {
      await booksOfStore(owner, storeId)
      return { id: storeId }
    },
    scope: 'organization',
    readPath: () => ApiRoutes.finance.paymentAccounts.list,
    own: {
      set: async (owner, storeId, marker) => {
        const organizationId = await organizationOfStore(owner, storeId)
        const books = await booksOf(owner, organizationId)
        await owner.paymentMethodAccount.deleteMany({ where: { organizationId } })
        await owner.paymentMethodAccount.create({
          data: {
            organizationId,
            paymentMethod: marker === 'A' ? 'CASH' : 'CARD',
            accountId: books.accounts.cash
          }
        })
      },
      markerIn: body => {
        const methods = (body as { paymentMethod: string }[]).map(row => row.paymentMethod)
        return methods.includes('CASH') ? 'A' : methods.includes('CARD') ? 'B' : null
      }
    },
    untouched: () => Promise.resolve(true)
  },
  // The tax rates are the organization's: read by the list, changed by id; no route reads one by its id
  {
    name: 'taxRate',
    create: async (owner, { storeId }) => {
      const organizationId = await organizationOfStore(owner, storeId)
      const books = await booksOf(owner, organizationId)
      return {
        id: (
          await owner.taxRate.create({
            data: {
              organizationId,
              code: `X${randomUUID().slice(0, 8)}`,
              name: 'Isolation rate',
              rateBps: 700,
              outputAccountId: books.accounts.liability,
              inputAccountId: books.accounts.cash
            },
            select: { id: true }
          })
        ).id
      }
    },
    scope: 'organization',
    listPath: ApiRoutes.finance.taxRates.list,
    // Switching it off is the change that does the most harm: the rate stops being taxed at, and the check also looks that the
    // other routes of the rate (rename, make default, switch on) left it as it was
    modify: { path: ApiRoutes.finance.taxRates.deactivate, method: 'post', body: {} },
    untouched: async (owner, id) => {
      const row = await owner.taxRate.findUnique({
        where: { id },
        select: { name: true, active: true, isDefault: true }
      })
      return row?.name !== 'hacked' && row?.active === true && row?.isDefault === false
    },
    creation: {
      path: ApiRoutes.finance.taxRates.create,
      body: name => {
        const books = financeBooksA
        if (books === null) throw new Error('the books of organization A are not set up')
        return {
          code: `C${randomUUID().slice(0, 8)}`,
          name,
          rateBps: 500,
          outputAccountId: books.accounts.liability,
          inputAccountId: books.accounts.cash
        }
      },
      strict: true,
      countIn: async (owner, storeId) =>
        owner.taxRate.count({
          where: { organizationId: await organizationOfStore(owner, storeId) }
        }),
      storeOf: async (owner, id) =>
        (await owner.taxRate.findUnique({ where: { id }, select: { organizationId: true } }))
          ?.organizationId ?? null
    }
  },
  {
    name: 'fiscalPeriod',
    create: async (owner, { storeId }) => {
      const organizationId = await organizationOfStore(owner, storeId)
      await booksOf(owner, organizationId)
      return { id: await createPeriod(owner, organizationId, nextPeriodYear(), 1) }
    },
    scope: 'organization',
    readPath: ApiRoutes.finance.periods.byId,
    listPath: ApiRoutes.finance.periods.list,
    // The change a route can try is the close, which must never freeze a month of another organization's books
    modify: { path: ApiRoutes.finance.periods.close, method: 'post', body: {} },
    untouched: async (owner, id) =>
      (await owner.fiscalPeriod.findUniqueOrThrow({ where: { id }, select: { status: true } }))
        .status === 'open',
    creation: {
      path: ApiRoutes.finance.periods.open,
      body: () => ({ year: nextOpenedYear(), month: 1 }),
      status: 200,
      strict: true,
      countIn: async (owner, storeId) =>
        owner.fiscalPeriod.count({
          where: { organizationId: await organizationOfStore(owner, storeId) }
        }),
      storeOf: async (owner, id) =>
        (await owner.fiscalPeriod.findUnique({ where: { id }, select: { organizationId: true } }))
          ?.organizationId ?? null
    }
  },
  // The issuer of the fiscal documents (TDD_18 §8): one row per organization, read through the store of the request and never by an
  // id, like the settings of the books. The credentials of the row are never in an answer.
  {
    name: 'fiscalIssuer',
    create: async (owner, { storeId }) => {
      const organizationId = await organizationOfStore(owner, storeId)
      await ensureFiscalIssuer(owner, organizationId)
      return { id: storeId }
    },
    scope: 'organization',
    readPath: () => ApiRoutes.fiscal.issuer,
    own: {
      set: async (owner, storeId, marker) => {
        await owner.fiscalIssuer.update({
          where: { organizationId: await organizationOfStore(owner, storeId) },
          data: { legalName: `iso-issuer-${marker}` }
        })
      },
      markerIn: body => {
        const name = (body as { data?: { legalName?: string } }).data?.legalName
        return name === 'iso-issuer-A' ? 'A' : name === 'iso-issuer-B' ? 'B' : null
      }
    },
    modify: {
      path: () => ApiRoutes.fiscal.issuer,
      method: 'put',
      body: {
        providerId: 'simulator',
        legalName: 'hacked',
        taxId: 'X',
        address: { line1: 'x' },
        environment: 'sandbox',
        issueOn: 'shipped',
        credentials: { signingKey: 'not-a-real-key' }
      }
    },
    untouched: async (owner, storeId) =>
      (
        await owner.fiscalIssuer.findUniqueOrThrow({
          where: { organizationId: await organizationOfStore(owner, storeId) },
          select: { legalName: true }
        })
      ).legalName !== 'hacked'
  },
  // The contingency of the issuer (Step 4B.7c-7): organization-scoped, reached by its id only to ask again for its report. A request from
  // another organization names a contingency it does not have: a 404, and the row stays as it was.
  {
    name: 'fiscalContingency',
    create: async (owner, { storeId }) => {
      const organizationId = await organizationOfStore(owner, storeId)
      const made = await owner.fiscalContingency.create({
        data: {
          organizationId,
          providerId: 'simulator',
          environment: 'sandbox',
          status: 'closed',
          origin: 'user',
          reason: 'iso',
          eventCode: randomUUID(),
          startedAt: new Date(),
          endedAt: new Date(),
          reportAttempts: 3,
          lastReportError: 'iso_error'
        },
        select: { id: true }
      })
      return { id: made.id }
    },
    scope: 'organization',
    modify: { path: id => ApiRoutes.fiscal.contingency.report(id), method: 'post', body: {} },
    untouched: async (owner, id) => {
      const row = await owner.fiscalContingency.findUnique({
        where: { id },
        select: { reportAttempts: true, lastReportError: true }
      })
      return row?.reportAttempts === 3 && row.lastReportError === 'iso_error'
    }
  },
  // The series of correlatives of the fiscal documents (Step 4B.7c-5): the counters of an organization, read through the store of the
  // request and never by an id; no route writes them (the lifecycle of a document does).
  {
    name: 'fiscalSequence',
    create: async (owner, { storeId }) => {
      await ensureFiscalIssuer(owner, await organizationOfStore(owner, storeId))
      return { id: storeId }
    },
    scope: 'organization',
    readPath: () => ApiRoutes.fiscal.series,
    own: {
      set: async (owner, storeId, marker) => {
        const organizationId = await organizationOfStore(owner, storeId)
        await owner.fiscalSequence.upsert({
          where: { organizationId_scopeKey: { organizationId, scopeKey: 'iso-series' } },
          create: {
            organizationId,
            scopeKey: 'iso-series',
            scope: { providerId: `iso-series-${marker}` },
            nextValue: 1
          },
          // A series only moves forward: the trigger refuses to change what it counts
          update: {}
        })
      },
      markerIn: body => {
        const series = (body as { data?: { scope?: { providerId?: string } }[] }).data ?? []
        const found = series.map(one => one.scope?.providerId)
        return found.includes('iso-series-A') ? 'A' : found.includes('iso-series-B') ? 'B' : null
      }
    },
    // No route changes a counter: the one of the isolation suite is still where it was made
    untouched: async (owner, storeId) =>
      (
        await owner.fiscalSequence.findUnique({
          where: {
            organizationId_scopeKey: {
              organizationId: await organizationOfStore(owner, storeId),
              scopeKey: 'iso-series'
            }
          }
        })
      )?.nextValue === 1
  },
  // The layout of a legal book (TDD_18 §7; Step 4B.8b-3): the layouts of an organization, read through the store of the request and never
  // by an id; a change is a new version of the organization's own, and an earlier version never changes.
  {
    name: 'financeBookLayout',
    create: async (owner, { storeId }) => {
      await booksOfStore(owner, storeId)
      return { id: storeId }
    },
    scope: 'organization',
    readPath: () => ApiRoutes.finance.bookLayouts.list,
    own: {
      set: async (owner, storeId, marker) => {
        const organizationId = await organizationOfStore(owner, storeId)
        const latest = await owner.financeBookLayout.aggregate({
          where: { organizationId, bookKind: 'purchases' },
          _max: { version: true }
        })
        await owner.financeBookLayout.create({
          data: {
            organizationId,
            bookKind: 'purchases',
            version: (latest._max.version ?? 0) + 1,
            columns: [{ field: 'total', label: `iso-layout-${marker}` }],
            sort: 'date',
            correlativeStart: 1,
            correlativeRestart: 'month',
            unissuedSales: 'consumers',
            createdBy: 'isolation-suite'
          }
        })
      },
      markerIn: body => {
        const raw = (body as { data?: unknown }).data ?? body
        const layouts = Array.isArray(raw)
          ? (raw as { kind?: string; columns?: { label?: string | null }[] }[])
          : []
        const label = layouts.find(layout => layout.kind === 'purchases')?.columns?.[0]?.label
        return label === 'iso-layout-A' ? 'A' : label === 'iso-layout-B' ? 'B' : null
      }
    },
    modify: {
      path: () => ApiRoutes.finance.bookLayouts.byKind('purchases'),
      method: 'put',
      body: {
        columns: [{ field: 'total', label: 'hacked' }],
        sort: 'date',
        correlativeStart: 1,
        correlativeRestart: 'month',
        unissuedSales: 'consumers',
        accountantConfirmed: false
      }
    },
    untouched: async (owner, storeId) => {
      const latest = await owner.financeBookLayout.findFirst({
        where: {
          organizationId: await organizationOfStore(owner, storeId),
          bookKind: 'purchases'
        },
        orderBy: { version: 'desc' },
        select: { columns: true }
      })
      return JSON.stringify(latest?.columns ?? []).includes('hacked') === false
    }
  },
  // A legal book frozen at the close of a period: read in its organization by id and in a list, never another's; no route changes it
  {
    name: 'financeBookSnapshot',
    create: async (owner, { storeId }) => {
      const organizationId = await organizationOfStore(owner, storeId)
      await booksOf(owner, organizationId)
      const periodId = await createPeriod(owner, organizationId, nextPeriodYear(), 1)
      const row = await owner.financeBookSnapshot.create({
        data: {
          organizationId,
          periodId,
          bookKind: 'purchases',
          layoutVersion: 0,
          closedAt: new Date(),
          book: {
            kind: 'purchases',
            period: {
              id: periodId,
              year: 2100,
              month: 1,
              from: '2100-01-01',
              to: '2100-01-31',
              status: 'closed'
            },
            layout: { version: 0, source: 'stored', accountantConfirmed: false },
            unvalidated: true,
            header: [],
            rows: [],
            totals: {},
            warnings: {},
            contentSha256: 'a'.repeat(64),
            csv: ''
          },
          contentSha256: 'a'.repeat(64),
          createdBy: 'isolation-suite'
        },
        select: { id: true }
      })
      return row
    },
    scope: 'organization',
    readPath: ApiRoutes.finance.frozenBooks.byId,
    listPath: ApiRoutes.finance.frozenBooks.list,
    untouched: async (owner, id) =>
      (
        await owner.financeBookSnapshot.findUnique({
          where: { id },
          select: { contentSha256: true }
        })
      )?.contentSha256 === 'a'.repeat(64)
  },
  // A fiscal document is the row of a sale of a store of the organization, and a person reaches it only in the stores where they hold the
  // permission (HC-128, owner 2026-11-18): the member of a sibling store gets a 404, as another organization does. No route makes one (the
  // sale does); the changes a person can try are the receiver, a retry and a void.
  {
    name: 'fiscalDocument',
    create: (owner, { storeId }) => createFiscalDocumentRow(owner, storeId),
    readPath: ApiRoutes.fiscal.documents.byId,
    listPath: ApiRoutes.fiscal.documents.list,
    modify: {
      path: ApiRoutes.fiscal.documents.retry,
      method: 'post',
      body: {}
    },
    untouched: async (owner, id) => {
      const row = await owner.fiscalDocument.findUnique({
        where: { id },
        select: { status: true, attempts: true, rejectionReason: true }
      })
      return row?.status === 'queued' && row.attempts === 0 && row.rejectionReason === null
    }
  },
  // The delivery of the files of a fiscal document to its receiver (Step 4B.7d): a row of the store of its document, read and recorded by hand
  // through the route of the document. A person who does not reach the document (another organization, or a store where they hold no
  // permission) gets a 404 on both, and the row stays as it was (still not sent, nobody recorded as having handed it over).
  {
    name: 'fiscalDelivery',
    create: async (owner, { storeId }) => {
      const document = await createFiscalDocumentRow(owner, storeId)
      const row = await owner.fiscalDelivery.create({
        data: {
          organizationId: await organizationOfStore(owner, storeId),
          storeId,
          documentId: document.id,
          orderId: (
            await owner.fiscalDocument.findUniqueOrThrow({
              where: { id: document.id },
              select: { orderId: true }
            })
          ).orderId,
          status: 'not_sent',
          route: 'none',
          reason: 'no_channel'
        },
        select: { id: true }
      })
      documentOfDelivery.set(row.id, document.id)
      return row
    },
    readPath: id => ApiRoutes.fiscal.documents.delivery(documentOfDelivery.get(id) ?? randomUUID()),
    modify: {
      path: id => ApiRoutes.fiscal.documents.delivery(documentOfDelivery.get(id) ?? randomUUID()),
      method: 'post',
      body: { means: 'paper' }
    },
    untouched: async (owner, id) => {
      const row = await owner.fiscalDelivery.findUnique({
        where: { id },
        select: { status: true, route: true, handedOverBy: true }
      })
      return row?.status === 'not_sent' && row.route === 'none' && row.handedOverBy === null
    }
  },
  // The journal is immutable: the only change a route can try is a reversal, which must never reach another organization's entry
  {
    name: 'journalEntry',
    create: async (owner, { storeId }) => {
      const books = await booksOfStore(owner, storeId)
      return { id: (await postTestEntry(owner, simpleEntry(books))).id }
    },
    scope: 'organization',
    readPath: ApiRoutes.finance.entries.byId,
    listPath: ApiRoutes.finance.entries.list,
    modify: {
      path: ApiRoutes.finance.entries.reverse,
      method: 'post',
      body: { memo: 'Reversed by the suite' }
    },
    untouched: async (owner, id) =>
      (await owner.journalEntry.count({ where: { reversesEntryId: id } })) === 0,
    creation: {
      path: ApiRoutes.finance.entries.manual,
      body: name => {
        const books = financeBooksA
        if (books === null) throw new Error('the books of organization A are not set up')
        return {
          idempotencyKey: `iso-${randomUUID()}`,
          entryDate: FINANCE_ENTRY_DATE,
          type: 'manual',
          memo: name,
          lines: [
            { accountId: books.accounts.expense, debitCents: 5 },
            { accountId: books.accounts.cash, creditCents: 5 }
          ]
        }
      },
      strict: true,
      countIn: async (owner, storeId) =>
        owner.journalEntry.count({
          where: { organizationId: await organizationOfStore(owner, storeId) }
        }),
      storeOf: async (owner, id) =>
        (await owner.journalEntry.findUnique({ where: { id }, select: { organizationId: true } }))
          ?.organizationId ?? null
    }
  },
  // What a person registers by hand: one row and one entry of the organization. The only change a route can try is voiding, which
  // must never reach another organization's transaction (and writes its reversing entry only in its own books)
  {
    name: 'financeTransaction',
    create: async (owner, { storeId }) => {
      const books = await booksOfStore(owner, storeId)
      const id = randomUUID()
      const entry = await postTestEntry(
        owner,
        simpleEntry(books, 900, {
          type: JournalEntryType.EXPENSE,
          sourceType: FinanceSourceType.FINANCE_TRANSACTION,
          sourceId: id
        })
      )
      await owner.financeTransaction.create({
        data: {
          id,
          organizationId: books.organizationId,
          kind: FinanceTransactionKind.EXPENSE,
          occurredOn: day(FINANCE_ENTRY_DATE),
          amountCents: 900,
          fromAccountId: books.accounts.cash,
          categoryAccountId: books.accounts.expense,
          clientKey: `iso-${id}`,
          entryId: entry.id,
          createdBy: 'isolation-suite'
        }
      })
      return { id }
    },
    scope: 'organization',
    readPath: ApiRoutes.finance.transactions.byId,
    listPath: ApiRoutes.finance.transactions.list,
    modify: {
      path: ApiRoutes.finance.transactions.void,
      method: 'post',
      body: { reason: 'Voided by the suite' }
    },
    untouched: async (owner, id) =>
      (
        await owner.financeTransaction.findUnique({
          where: { id },
          select: { voidedByEntryId: true }
        })
      )?.voidedByEntryId === null
    // No `creation` check: the body may name a store of the organization (the dimension of the lines), so a store of ANOTHER organization
    // is a 404 and not the 400 of a strict body; tests/api/finance-transactions.spec.ts proves that and that nothing is written
  },
  // The suppliers, their orders and the payments made to them belong to the ORGANIZATION (TDD_18 §2.1): every store of it reaches them
  // with the permission, another organization never does. The lines of an order are the stores' (see the block of purchases below).
  {
    name: 'supplier',
    create: async (owner, { storeId }) => ({
      id: (await createSupplierOf(owner, await organizationOfStore(owner, storeId))).id
    }),
    scope: 'organization',
    readPath: ApiRoutes.suppliers.byId,
    listPath: ApiRoutes.suppliers.list,
    modify: { path: ApiRoutes.suppliers.update, body: { name: 'hacked' } },
    untouched: async (owner, id) =>
      (await owner.supplier.findUnique({ where: { id }, select: { name: true } }))?.name !==
      'hacked',
    creation: {
      path: ApiRoutes.suppliers.create,
      body: name => ({ name }),
      strict: true,
      countIn: async (owner, storeId) =>
        owner.supplier.count({
          where: { organizationId: await organizationOfStore(owner, storeId) }
        }),
      storeOf: async (owner, id) =>
        (await owner.supplier.findUnique({ where: { id }, select: { organizationId: true } }))
          ?.organizationId ?? null
    }
  },
  {
    name: 'purchaseOrder',
    create: async (owner, { storeId }) => ({
      id: (await createPurchaseOrderOf(owner, await organizationOfStore(owner, storeId))).id
    }),
    scope: 'organization',
    readPath: ApiRoutes.purchaseOrders.byId,
    listPath: ApiRoutes.purchaseOrders.list,
    modify: { path: ApiRoutes.purchaseOrders.update, body: { notes: 'hacked' } },
    untouched: async (owner, id) =>
      (await owner.purchaseOrder.findUnique({ where: { id }, select: { notes: true } }))?.notes !==
      'hacked'
    // No `creation` check: the body names a supplier and a warehouse, so ids of ANOTHER organization are a 404 and not the 400 of a
    // strict body; tests/api/purchases.spec.ts proves that
  },
  // The lines, the receipts and the lines of a receipt have no route of their own: they are read and changed through their order (the
  // header is the organization's, so these are organization-scoped here; the block "purchase orders of an organization" below proves
  // that a member sees only the lines of THEIR stores)
  {
    name: 'purchaseOrderLine',
    create: async (owner, { storeId }) => ({
      id: (await createReceiptOf(owner, storeId)).orderLineId
    }),
    ...purchaseRowChecks
  },
  {
    name: 'purchaseReceipt',
    create: async (owner, { storeId }) => ({
      id: (await createReceiptOf(owner, storeId)).receiptId
    }),
    ...purchaseRowChecks
  },
  {
    name: 'purchaseReceiptLine',
    create: async (owner, { storeId }) => ({
      id: (await createReceiptOf(owner, storeId)).receiptLineId
    }),
    ...purchaseRowChecks
  },
  {
    name: 'supplierPayment',
    create: async (owner, { storeId }) => {
      const books = await booksOfStore(owner, storeId)
      const supplier = await createSupplierOf(owner, books.organizationId)
      const id = randomUUID()
      const entry = await postTestEntry(
        owner,
        simpleEntry(books, 800, {
          type: JournalEntryType.SUPPLIER_PAYMENT,
          sourceType: FinanceSourceType.SUPPLIER_PAYMENT,
          sourceId: id
        })
      )
      await owner.supplierPayment.create({
        data: {
          id,
          organizationId: books.organizationId,
          supplierId: supplier.id,
          paidFromAccountId: books.accounts.cash,
          amountCents: 800,
          paidOn: day(FINANCE_ENTRY_DATE),
          clientKey: `iso-${id}`,
          entryId: entry.id,
          createdBy: 'isolation-suite'
        }
      })
      supplierOfPayment.set(id, supplier.id)
      return { id }
    },
    scope: 'organization',
    // A payment has no route by id: it is read in the list of its supplier
    readPath: id => ApiRoutes.suppliers.payments(supplierOfPayment.get(id) ?? randomUUID()),
    modify: {
      path: ApiRoutes.supplierPayments.void,
      method: 'post',
      body: { reason: 'Voided by the suite' }
    },
    untouched: async (owner, id) =>
      (
        await owner.supplierPayment.findUnique({
          where: { id },
          select: { voidedByEntryId: true }
        })
      )?.voidedByEntryId === null
  },
  // What a supplier gave back of a payment is the organization's: listed under its payment, voided by id, never read or voided by another
  {
    name: 'supplierPaymentReturn',
    create: async (owner, { storeId }) => {
      const books = await booksOfStore(owner, storeId)
      const supplier = await createSupplierOf(owner, books.organizationId)
      const paymentId = randomUUID()
      const paymentEntry = await postTestEntry(
        owner,
        simpleEntry(books, 800, {
          type: JournalEntryType.SUPPLIER_PAYMENT,
          sourceType: FinanceSourceType.SUPPLIER_PAYMENT,
          sourceId: paymentId
        })
      )
      await owner.supplierPayment.create({
        data: {
          id: paymentId,
          organizationId: books.organizationId,
          supplierId: supplier.id,
          paidFromAccountId: books.accounts.cash,
          amountCents: 800,
          paidOn: day(FINANCE_ENTRY_DATE),
          clientKey: `iso-${paymentId}`,
          entryId: paymentEntry.id,
          createdBy: 'isolation-suite'
        }
      })
      const id = randomUUID()
      const entry = await postTestEntry(
        owner,
        simpleEntry(books, 300, {
          type: JournalEntryType.SUPPLIER_PAYMENT_RETURN,
          sourceType: FinanceSourceType.SUPPLIER_PAYMENT_RETURN,
          sourceId: id
        })
      )
      await owner.supplierPaymentReturn.create({
        data: {
          id,
          organizationId: books.organizationId,
          supplierId: supplier.id,
          supplierPaymentId: paymentId,
          receivedIntoAccountId: books.accounts.cash,
          amountCents: 300,
          returnedOn: day(FINANCE_ENTRY_DATE),
          clientKey: `iso-${id}`,
          entryId: entry.id,
          createdBy: 'isolation-suite'
        }
      })
      paymentOfReturn.set(id, paymentId)
      return { id }
    },
    scope: 'organization',
    readPath: id => ApiRoutes.supplierPayments.returns(paymentOfReturn.get(id) ?? randomUUID()),
    modify: {
      path: ApiRoutes.supplierPaymentReturns.void,
      method: 'post',
      body: { reason: 'Voided by the suite' }
    },
    untouched: async (owner, id) =>
      (
        await owner.supplierPaymentReturn.findUnique({
          where: { id },
          select: { voidedByEntryId: true }
        })
      )?.voidedByEntryId === null
  },
  // The reading profile of a bank's CSV is the organization's: listed and changed by id, never read by it
  {
    name: 'bankImportProfile',
    create: async (owner, { storeId }) => {
      const books = await booksOfStore(owner, storeId)
      return {
        id: (
          await owner.bankImportProfile.create({
            data: {
              organizationId: books.organizationId,
              accountId: books.accounts.cash,
              name: `Isolation ${randomUUID().slice(0, 8)}`,
              columns: { date: 'Date', amount: 'Amount' },
              createdBy: 'isolation-suite'
            },
            select: { id: true }
          })
        ).id
      }
    },
    scope: 'organization',
    listPath: ApiRoutes.finance.bank.profiles,
    modify: {
      path: ApiRoutes.finance.bank.profileById,
      method: 'patch',
      body: { name: 'hacked' }
    },
    untouched: async (owner, id) =>
      (await owner.bankImportProfile.findUnique({ where: { id }, select: { name: true } }))
        ?.name !== 'hacked',
    creation: {
      path: ApiRoutes.finance.bank.profiles,
      body: name => {
        const books = financeBooksA
        if (books === null) throw new Error('the books of organization A are not set up')
        return { accountId: books.accounts.cash, name, columns: { date: 'Date', amount: 'Amount' } }
      },
      strict: true,
      countIn: async (owner, storeId) =>
        owner.bankImportProfile.count({
          where: { organizationId: await organizationOfStore(owner, storeId) }
        }),
      storeOf: async (owner, id) =>
        (
          await owner.bankImportProfile.findUnique({
            where: { id },
            select: { organizationId: true }
          })
        )?.organizationId ?? null
    }
  },
  // An imported statement is the organization's and no route changes it: it is read by id and listed
  {
    name: 'bankStatementImport',
    create: async (owner, { storeId }) => ({
      id: (await bankStatementOf(owner, storeId)).importId
    }),
    scope: 'organization',
    readPath: ApiRoutes.finance.bank.importById,
    listPath: ApiRoutes.finance.bank.imports,
    untouched: () => Promise.resolve(true)
  },
  // With an entry on the cash account the line has an exact suggestion: a request that reached these lines would confirm it.
  // The lines belong to their import: they are read with it, and the one change a route can try is to confirm what the books suggest,
  // which must never reach another organization's lines
  {
    name: 'bankStatementLine',
    create: async (owner, { storeId }) => {
      const statement = await bankStatementOf(owner, storeId, -700)
      await postTestEntry(owner, simpleEntry(await booksOfStore(owner, storeId), 700))
      return { id: statement.importId }
    },
    scope: 'organization',
    readPath: ApiRoutes.finance.bank.importLines,
    modify: { path: ApiRoutes.finance.bank.confirmExact, method: 'post', body: {} },
    untouched: async (owner, id) =>
      (await owner.reconciliationMatch.count({ where: { statementLine: { importId: id } } })) === 0
  },
  // A statement line is matched with a GROUP of lines of the books by one request (HC-121): the route writes the decisions of the model, and
  // a request of another organization finds no line (the id of this case is the statement line's)
  {
    name: 'reconciliationMatch',
    create: async (owner, { storeId }) => {
      const statement = await bankStatementOf(owner, storeId, 700)
      importOfGroupLine.set(statement.lineId, statement.importId)
      return { id: statement.lineId }
    },
    scope: 'organization',
    // The line is read with its import
    readPath: id => ApiRoutes.finance.bank.importLines(importOfGroupLine.get(id) ?? randomUUID()),
    modify: {
      path: ApiRoutes.finance.bank.lineGroupMatches,
      method: 'post',
      body: { journalLineIds: [randomUUID(), randomUUID()] }
    },
    untouched: async (owner, id) =>
      (await owner.reconciliationMatch.count({ where: { statementLineId: id } })) === 0
  },
  // A decision of a person: no route reads one; the change a stranger could try is to take it back
  {
    name: 'reconciliationMatch',
    create: async (owner, { storeId }) => {
      const statement = await bankStatementOf(owner, storeId, -700)
      const books = await booksOfStore(owner, storeId)
      const entry = await postTestEntry(owner, simpleEntry(books, 700))
      const book = entry.lines.find(line => line.accountId === statement.accountId)
      if (book === undefined) throw new Error('the entry has no line of the cash account')
      return {
        id: (
          await owner.reconciliationMatch.create({
            data: {
              organizationId: statement.organizationId,
              statementLineId: statement.lineId,
              journalLineId: book.id,
              status: 'confirmed',
              decidedBy: 'isolation-suite'
            },
            select: { id: true }
          })
        ).id
      }
    },
    scope: 'organization',
    modify: { path: ApiRoutes.finance.bank.matchUndo, method: 'post', body: {} },
    untouched: async (owner, id) =>
      (await owner.reconciliationMatch.findUnique({ where: { id }, select: { status: true } }))
        ?.status === 'confirmed'
  },
  // The lines belong to their entry: they are read with it, and the store of a line is a dimension and not a scope
  {
    name: 'journalLine',
    create: async (owner, { storeId }) => {
      const books = await booksOfStore(owner, storeId)
      return { id: (await postTestEntry(owner, simpleEntry(books, 700))).id }
    },
    scope: 'organization',
    readPath: ApiRoutes.finance.entries.byId,
    modify: {
      path: ApiRoutes.finance.entries.reverse,
      method: 'post',
      body: { memo: 'Reversed by the suite' }
    },
    untouched: async (owner, id) =>
      (await owner.journalEntry.count({ where: { reversesEntryId: id } })) === 0
  },
  // What each account has had debited and credited: one set per organization, told apart by an amount only its set posts
  {
    name: 'accountPeriodBalance',
    create: async (owner, { storeId }) => {
      await booksOfStore(owner, storeId)
      return { id: storeId }
    },
    scope: 'organization',
    readPath: () => ApiRoutes.finance.balances,
    own: {
      set: async (owner, storeId, marker) => {
        const books = await booksOfStore(owner, storeId)
        const cents = marker === 'A' ? FINANCE_MARKERS.A.cents : FINANCE_MARKERS.B.cents
        await postTestEntry(owner, {
          organizationId: books.organizationId,
          periodId: books.periodId,
          lines: [
            { accountId: books.accounts.expense, debitCents: cents },
            { accountId: books.accounts.liability, creditCents: cents }
          ]
        })
      },
      markerIn: body => {
        const credits = (body as { data: { creditCents: string }[] }).data.map(
          row => row.creditCents
        )
        return credits.includes(String(FINANCE_MARKERS.A.cents))
          ? 'A'
          : credits.includes(String(FINANCE_MARKERS.B.cents))
            ? 'B'
            : null
      }
    },
    untouched: () => Promise.resolve(true)
  },
  // Same model as the case above, read by the report of a date (the case names must be models): the lines of the organization of the request and no other
  {
    name: 'accountPeriodBalance',
    create: async (owner, { storeId }) => {
      await booksOfStore(owner, storeId)
      return { id: storeId }
    },
    scope: 'organization',
    readPath: () => `${ApiRoutes.finance.reports.accountBalances}?asOf=2026-12-31`,
    own: {
      set: (owner, storeId, marker) => postMarkedEntry(owner, storeId, marker),
      markerIn: body =>
        (body as { rows: { name: string }[] }).rows
          .map(row => reportMarkerOf(row.name))
          .find(found => found !== null) ?? null
    },
    untouched: () => Promise.resolve(true)
  },
  // Same model as the case of the entries, read by the journal report with its lines (TDD_18 §10): the entries of the organization of the request and no other
  {
    name: 'journalEntry',
    create: async (owner, { storeId }) => {
      await booksOfStore(owner, storeId)
      return { id: storeId }
    },
    scope: 'organization',
    readPath: () => `${ApiRoutes.finance.reports.journal}?from=2026-11-01&to=2026-11-30`,
    own: {
      set: (owner, storeId, marker) => postMarkedEntry(owner, storeId, marker),
      markerIn: body =>
        (body as { data: { memo: string | null }[] }).data
          .map(entry => reportMarkerOf(entry.memo))
          .find(found => found !== null) ?? null
    },
    untouched: () => Promise.resolve(true)
  },
  // The incident the weekly check of the chain left open (TDD_18 §11): one open row per organization, read through the store of the request
  {
    name: 'financeChainIncident',
    create: async (owner, { storeId }) => {
      await booksOfStore(owner, storeId)
      return { id: storeId }
    },
    scope: 'organization',
    readPath: () => ApiRoutes.finance.reports.chainStatus,
    own: {
      set: async (owner, storeId, marker) => {
        const organizationId = await organizationOfStore(owner, storeId)
        await owner.financeChainIncident.deleteMany({ where: { organizationId } })
        await owner.financeChainIncident.create({
          data: {
            organizationId,
            reason: 'hash_mismatch',
            entryNumber: `marker-${marker}`,
            entriesChecked: 1,
            lastSeenAt: new Date()
          }
        })
      },
      markerIn: body => {
        type Open = { entryNumber?: string } | null
        const shape = body as { open?: Open; data?: { open?: Open } }
        const open = shape.open ?? shape.data?.open
        return open?.entryNumber?.slice(-1) ?? null
      }
    },
    untouched: () => Promise.resolve(true)
  },
  {
    name: 'financePostingFailure',
    create: async (owner, { storeId }) => {
      await booksOfStore(owner, storeId)
      return { id: storeId }
    },
    scope: 'organization',
    readPath: () => ApiRoutes.finance.postings,
    own: {
      set: async (owner, storeId, marker) => {
        const organizationId = await organizationOfStore(owner, storeId)
        await owner.financePostingFailure.deleteMany({ where: { organizationId } })
        await owner.financePostingFailure.create({
          data: {
            organizationId,
            sourceType: 'order',
            sourceId: `marker-${marker}`,
            eventKind: 'sale',
            reason: 'role_not_mapped'
          }
        })
      },
      markerIn: body => {
        const row = (body as { data: { sourceId: string }[] }).data[0]
        return row === undefined ? null : row.sourceId.slice(-1)
      }
    },
    untouched: () => Promise.resolve(true)
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
      body: () => ({ url: `https://8.8.8.8/hook/${randomUUID()}`, events: ['order.created'] }),
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
  // Step 5.4 PR B: the windows of the data retention of a store. One row per store, read and written through the store of
  // the request. The nightly run that deletes by them is proved in tests/api/retention-run.spec.ts: a run of one store
  // leaves the conversations, files, events and notifications of another.
  {
    name: 'retentionSettings',
    create: async (owner, { storeId }) => {
      await owner.retentionSettings.upsert({
        where: { storeId },
        create: { storeId },
        update: {}
      })
      return { id: storeId }
    },
    own: {
      set: async (owner, storeId, marker) => {
        await owner.retentionSettings.upsert({
          where: { storeId },
          create: { storeId, conversationDays: marker === 'A' ? 111 : 222 },
          update: { conversationDays: marker === 'A' ? 111 : 222 }
        })
      },
      markerIn: body => {
        const days = (body as { conversationDays?: number }).conversationDays
        return days === 111 ? 'A' : days === 222 ? 'B' : null
      }
    },
    readPath: () => ApiRoutes.settings.retention,
    modify: {
      path: () => ApiRoutes.settings.retention,
      method: 'put',
      body: { conversationDays: 333, mediaDays: 333, analyticsDays: 333, notificationDays: 33 }
    },
    untouched: async (owner, id) =>
      (
        await owner.retentionSettings.findUnique({
          where: { storeId: id },
          select: { conversationDays: true }
        })
      )?.conversationDays !== 333
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
        await dropCachedSettings(storeId, 'preferences') // Written behind the api's back: see the builder
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
  // The audit log is read through its viewer (Step 7.2-E): a row is the store's, and a row with no store is nobody's. The table is
  // immutable, so no route changes an entry and the case has no `modify`.
  {
    name: 'auditLog',
    create: async (owner, { storeId }) => {
      const admin = await owner.membership.findFirstOrThrow({
        where: { storeId, role: { name: RoleNames.ADMIN } },
        select: { userId: true }
      })
      return owner.auditLog.create({
        data: { action: `isolation.${randomUUID()}`, userId: admin.userId, storeId },
        select: { id: true }
      })
    },
    readPath: ApiRoutes.organizations.auditLogEntry,
    listPath: ApiRoutes.organizations.auditLog,
    untouched: async (owner, id) =>
      (await owner.auditLog.findUnique({ where: { id }, select: { id: true } })) !== null
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
    financeBooksA = await booksOf(owner, ctx.orgA.id)
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

  // The books belong to the organization (TDD_18 §2.1, §9.2): the checks above prove that another organization reaches none of
  // them by id; these prove the rest of the rules of an organization-scoped ledger, through the api
  describe('the books of an organization', () => {
    it('are the same for a member of any store of the organization, and none of the other organization', async () => {
      const own = await postTestEntry(owner, simpleEntry(await booksOf(owner, ctx.orgA.id), 321))
      const foreign = await postTestEntry(
        owner,
        simpleEntry(await booksOf(owner, ctx.orgB.id), 321)
      )

      const fromSibling = await api(app, ctx.adminA2, ctx.storeA2)
        .get(ApiRoutes.finance.entries.list)
        .query({ limit: 100 })

      expect(fromSibling.status).toBe(200)
      const ids = (fromSibling.body as { data: { id: string }[] }).data.map(row => row.id)
      expect(ids).toContain(own.id)
      expect(ids).not.toContain(foreign.id)
    })

    it('give the ledger of a party only its own organization: another organization asking by the party or by the account sees nothing', async () => {
      const books = await booksOf(owner, ctx.orgA.id)
      const booksOfB = await booksOf(owner, ctx.orgB.id)
      const partyId = randomUUID()
      await postTestEntry(owner, {
        organizationId: ctx.orgA.id,
        periodId: books.periodId,
        lines: [
          {
            accountId: books.accounts.expense,
            debitCents: 5151,
            partyType: 'supplier',
            partyId
          },
          { accountId: books.accounts.cash, creditCents: 5151 }
        ]
      })
      const party = { partyType: 'supplier', partyId }

      const own = await api(app, ctx.adminA, ctx.storeA)
        .get(ApiRoutes.finance.reports.ledger)
        .query({ accountId: books.accounts.expense, ...party })
      const byAccountOfA = await api(app, ctx.adminB, ctx.storeB)
        .get(ApiRoutes.finance.reports.ledger)
        .query({ accountId: books.accounts.expense, ...party })
      const byPartyOfA = await api(app, ctx.adminB, ctx.storeB)
        .get(ApiRoutes.finance.reports.ledger)
        .query({ accountId: booksOfB.accounts.expense, ...party })

      // The filter finds the line for the organization that posted it ...
      expect((own.body as { lines: unknown[] }).lines).toHaveLength(1)
      // ... and the other organization gets 404 for the account and no line for the party, with no figure of the first
      expect(byAccountOfA.status).toBe(404)
      expect(byPartyOfA.status).toBe(200)
      expect((byPartyOfA.body as { lines: unknown[] }).lines).toEqual([])
      // The 404 carries no ledger at all (no lines, so no figure of the first organization); the 200 of the party was
      // asserted empty above. Not a search for "5151" as text: an error body carries random ids that contain it by chance
      expect(byAccountOfA.body).not.toHaveProperty('lines')
    })

    it('show every line of an entry whatever store the line is tagged with: the store of a line is a dimension and not a scope', async () => {
      const books = await booksOf(owner, ctx.orgA.id)
      const entry = await postTestEntry(owner, {
        organizationId: ctx.orgA.id,
        periodId: books.periodId,
        lines: [
          { accountId: books.accounts.expense, debitCents: 90, storeId: ctx.storeA.id },
          { accountId: books.accounts.expense, debitCents: 10, storeId: ctx.storeA2.id },
          { accountId: books.accounts.cash, creditCents: 100 }
        ]
      })

      const fromA = await api(app, ctx.adminA, ctx.storeA).get(
        ApiRoutes.finance.entries.byId(entry.id)
      )
      const fromA2 = await api(app, ctx.adminA2, ctx.storeA2).get(
        ApiRoutes.finance.entries.byId(entry.id)
      )

      const stores = (body: unknown) =>
        (body as { lines: { storeId: string | null }[] }).lines.map(line => line.storeId)
      expect(stores(fromA.body)).toEqual([ctx.storeA.id, ctx.storeA2.id, null])
      expect(stores(fromA2.body)).toEqual(stores(fromA.body))
    })

    it('refuse a line charged to a sibling store of which the person is not a member, and take one of a store they belong to (SEG-228)', async () => {
      const books = await booksOf(owner, ctx.orgA.id)
      const before = await owner.journalEntry.count({ where: { organizationId: ctx.orgA.id } })
      const body = (storeId: string) => ({
        idempotencyKey: `k${randomUUID().replaceAll('-', '')}`,
        entryDate: new Date().toISOString().slice(0, 10),
        type: JournalEntryType.MANUAL,
        memo: 'SEG-228',
        lines: [
          { accountId: books.accounts.expense, debitCents: 11, storeId },
          { accountId: books.accounts.cash, creditCents: 11 }
        ]
      })

      // adminA belongs to the first store of the organization and not to its sibling
      const refused = await api(app, ctx.adminA, ctx.storeA)
        .post(ApiRoutes.finance.entries.manual)
        .send(body(ctx.storeA2.id))
      const ofAnotherOrganization = await api(app, ctx.adminA, ctx.storeA)
        .post(ApiRoutes.finance.entries.manual)
        .send(body(ctx.storeB.id))
      const own = await api(app, ctx.adminA, ctx.storeA)
        .post(ApiRoutes.finance.entries.manual)
        .send(body(ctx.storeA.id))

      expect(refused.status).toBe(404)
      // A store that is not the person's and one that does not exist in their organization answer the same
      expect(ofAnotherOrganization.status).toBe(404)
      expect(own.status).toBe(201)
      expect(await owner.journalEntry.count({ where: { organizationId: ctx.orgA.id } })).toBe(
        before + 1
      )
    })

    it('are told the balances of one store of the organization, and never those of a store of another', async () => {
      const books = await booksOf(owner, ctx.orgA.id)
      await postTestEntry(owner, {
        organizationId: ctx.orgA.id,
        periodId: books.periodId,
        lines: [
          { accountId: books.accounts.expense, debitCents: 7, storeId: ctx.storeA.id },
          { accountId: books.accounts.cash, creditCents: 7 }
        ]
      })

      const forA = await api(app, ctx.adminA, ctx.storeA)
        .get(ApiRoutes.finance.balances)
        .query({ storeId: ctx.storeA.id })
      // The other organization has a line tagged with its own store: it is the only thing that could leak
      const booksB = await booksOf(owner, ctx.orgB.id)
      await postTestEntry(owner, {
        organizationId: ctx.orgB.id,
        periodId: booksB.periodId,
        lines: [
          { accountId: booksB.accounts.expense, debitCents: 9, storeId: ctx.storeB.id },
          { accountId: booksB.accounts.cash, creditCents: 9 }
        ]
      })
      const forB = await api(app, ctx.adminA, ctx.storeA)
        .get(ApiRoutes.finance.balances)
        .query({ storeId: ctx.storeB.id })

      expect((forA.body as { data: unknown[] }).data.length).toBeGreaterThan(0)
      expect((forB.body as { data: unknown[] }).data).toEqual([])
    })

    it('are not chosen by the request: an organization in the query or in the body is refused, never read', async () => {
      const query = await api(app, ctx.adminA, ctx.storeA)
        .get(ApiRoutes.finance.entries.list)
        .query({ organizationId: ctx.orgB.id })
      const body = await api(app, ctx.adminA, ctx.storeA)
        .post(ApiRoutes.finance.accounts.create)
        .send({
          code: `Z${randomUUID().slice(0, 8)}`,
          name: 'Elsewhere',
          type: 'expense',
          organizationId: ctx.orgB.id
        })

      expect([query.status, body.status]).toEqual([400, 400])
      expect(await owner.ledgerAccount.count({ where: { name: 'Elsewhere' } })).toBe(0)
    })

    it('of another organization cannot be reversed, mapped or switched off, and nothing is written', async () => {
      const books = await booksOf(owner, ctx.orgB.id)
      const theirs = await postTestEntry(owner, simpleEntry(books, 55))
      const entries = await owner.journalEntry.count({ where: { organizationId: ctx.orgB.id } })
      const agent = api(app, ctx.adminA, ctx.storeA)

      const attempts = [
        await agent.post(ApiRoutes.finance.entries.reverse(theirs.id)).send({ memo: 'mine now' }),
        await agent.post(ApiRoutes.finance.accounts.deactivate(books.accounts.expense)),
        await agent
          .put(ApiRoutes.finance.accountRoles.byRole('cash_default'))
          .send({ accountId: books.accounts.cash })
      ]

      expect(attempts.map(attempt => attempt.status)).toEqual([404, 404, 404])
      expect(await owner.journalEntry.count({ where: { organizationId: ctx.orgB.id } })).toBe(
        entries
      )
      expect(
        (await owner.ledgerAccount.findUniqueOrThrow({ where: { id: books.accounts.expense } }))
          .active
      ).toBe(true)
    })

    it('are not reached through the header of a store of another organization', async () => {
      const response = await api(app, ctx.adminA, ctx.storeB).get(ApiRoutes.finance.entries.list)

      expect(response.status).toBe(403)
    })
  })

  // The purchase orders belong to the organization, their lines to the stores whose products are bought (TDD_18 §2.1): the
  // checks above prove that another organization reaches none of them; these prove that line visibility is the caller's stores
  describe('fiscal documents of an organization', () => {
    it('are not read, changed or voided by a member who holds no permission in the store of the sale (HC-128)', async () => {
      const organizationId = ctx.orgA.id
      await ensureFiscalIssuer(owner, organizationId)
      const order = await createOrder(owner, { storeId: ctx.storeA.id })
      const document = await owner.fiscalDocument.create({
        data: {
          organizationId,
          storeId: ctx.storeA.id,
          orderId: order.id,
          sequenceNumber: randomInt(1_000_000, 2_000_000_000),
          documentType: 'pending',
          status: 'queued',
          providerId: 'simulator',
          environment: 'sandbox',
          issuerSnapshot: {},
          linesSnapshot: { lines: [] },
          receiverEncrypted: Buffer.from('isolation-fixture'),
          totalCents: 1999,
          taxCents: 0
        },
        select: { id: true }
      })
      const fromSibling = api(app, ctx.adminA2, ctx.storeA2)
      const fromOwn = api(app, ctx.adminA, ctx.storeA)
      const missing = await fromSibling.get(ApiRoutes.fiscal.documents.byId(randomUUID()))

      const answers = [
        await fromSibling.get(ApiRoutes.fiscal.documents.byId(document.id)),
        await fromSibling.get(ApiRoutes.fiscal.documents.evidence(document.id, 'document')),
        await fromSibling
          .patch(ApiRoutes.fiscal.documents.receiver(document.id))
          .send({ name: 'x' }),
        await fromSibling.post(ApiRoutes.fiscal.documents.retry(document.id)).send({}),
        await fromSibling
          .post(ApiRoutes.fiscal.documents.void(document.id))
          .send({ reason: 'isolation check' }),
        await fromSibling.post(ApiRoutes.fiscal.documents.replace(document.id)).send({}),
        await fromSibling
          .post(ApiRoutes.fiscal.documents.confirmIssuerChange(document.id))
          .send({ reason: 'isolation check' })
      ]
      // A document of the store of the caller that names a replacement of another store: the replacement is out of reach too
      const own = await owner.fiscalDocument.create({
        data: {
          organizationId,
          storeId: ctx.storeA2.id,
          orderId: (await createOrder(owner, { storeId: ctx.storeA2.id })).id,
          sequenceNumber: randomInt(1_000_000, 2_000_000_000),
          documentType: 'pending',
          status: 'accepted',
          providerId: 'simulator',
          environment: 'sandbox',
          issuerSnapshot: {},
          linesSnapshot: { lines: [] },
          receiverEncrypted: Buffer.from('isolation-fixture'),
          totalCents: 1999,
          taxCents: 0
        },
        select: { id: true }
      })
      const withForeignReplacement = await fromSibling
        .post(ApiRoutes.fiscal.documents.void(own.id))
        .send({ reason: 'isolation check', replacementDocumentId: document.id })
      expect(withForeignReplacement.status).toBe(missing.status)
      expect((await owner.fiscalDocument.findUniqueOrThrow({ where: { id: own.id } })).status).toBe(
        'accepted'
      )
      // The reconciliation of the sibling never names the order of the other store (a queued document stalled long ago is a finding)
      await owner.fiscalDocument.update({
        where: { id: document.id },
        data: { updatedAt: new Date(Date.now() - 24 * 3_600_000) }
      })
      const findings = await fromSibling
        .get(ApiRoutes.fiscal.reconciliation)
        .query({ kind: 'stalled_document', limit: 100 })
      expect(findings.status).toBe(200)
      expect(JSON.stringify(findings.body)).not.toContain(document.id)
      const listed = await fromSibling.get(ApiRoutes.fiscal.documents.list).query({ limit: 100 })

      // The same answer as a document that does not exist: nothing says it is there
      for (const answer of answers) {
        expect(answer.status).toBe(missing.status)
        expect((answer.body as { error: unknown }).error).toEqual(
          (missing.body as { error: unknown }).error
        )
      }
      expect(listed.status).toBe(200)
      expect((listed.body as { data: { id: string }[] }).data.map(row => row.id)).not.toContain(
        document.id
      )
      const row = await owner.fiscalDocument.findUniqueOrThrow({
        where: { id: document.id },
        select: { status: true, attempts: true }
      })
      expect(row).toEqual({ status: 'queued', attempts: 0 })
      // The member of the store of the sale does reach it
      expect((await fromOwn.get(ApiRoutes.fiscal.documents.byId(document.id))).status).toBe(200)
    })
  })

  describe('purchase orders of an organization', () => {
    it("show a member only the lines of their stores, though the header is the organization's", async () => {
      const own = await owner.product.create({
        data: { storeId: ctx.storeA.id, name: `p-${randomUUID().slice(0, 6)}`, priceCents: 100 },
        select: { id: true }
      })
      const sibling = await owner.product.create({
        data: { storeId: ctx.storeA2.id, name: `p-${randomUUID().slice(0, 6)}`, priceCents: 100 },
        select: { id: true }
      })
      const order = await createPurchaseOrderOf(owner, ctx.orgA.id, {
        storeId: ctx.storeA.id,
        productId: own.id
      })
      await owner.purchaseOrderLine.create({
        data: {
          organizationId: ctx.orgA.id,
          storeId: ctx.storeA2.id,
          purchaseOrderId: order.id,
          lineNo: 2,
          productId: sibling.id,
          quantity: 1,
          unitCostCents: 100
        }
      })

      const fromA = await api(app, ctx.adminA, ctx.storeA).get(
        ApiRoutes.purchaseOrders.byId(order.id)
      )
      const fromA2 = await api(app, ctx.adminA2, ctx.storeA2).get(
        ApiRoutes.purchaseOrders.byId(order.id)
      )

      const storesOf = (response: { body: unknown }): string[] =>
        (response.body as { lines: { storeId: string }[] }).lines.map(line => line.storeId)
      expect(fromA.status).toBe(200)
      expect(storesOf(fromA)).toEqual([ctx.storeA.id])
      expect(fromA2.status).toBe(200)
      expect(storesOf(fromA2)).toEqual([ctx.storeA2.id])
    })

    it('of another organization cannot be edited, placed, received, closed, cancelled or paid', async () => {
      const foreign = await createPurchaseOrderOf(owner, ctx.orgB.id)
      const row = await owner.purchaseOrder.findUniqueOrThrow({ where: { id: foreign.id } })
      const agent = api(app, ctx.adminA, ctx.storeA)

      const attempts = [
        await agent.post(ApiRoutes.purchaseOrders.order(foreign.id)),
        await agent.post(ApiRoutes.purchaseOrders.receive(foreign.id)).send({
          idempotencyKey: randomUUID().replaceAll('-', ''),
          receivedOn: '2026-11-10',
          lines: [{ orderLineId: randomUUID(), quantity: 1 }]
        }),
        await agent.post(ApiRoutes.purchaseOrders.close(foreign.id)).send({}),
        await agent.post(ApiRoutes.purchaseOrders.cancel(foreign.id)).send({}),
        await agent.post(ApiRoutes.suppliers.recordPayment(row.supplierId)).send({
          idempotencyKey: randomUUID().replaceAll('-', ''),
          paidFromAccountId: randomUUID(),
          amountCents: 100,
          paidOn: '2026-11-10'
        })
      ]

      expect(attempts.map(attempt => attempt.status)).toEqual([404, 404, 404, 404, 404])
      expect(
        (await owner.purchaseOrder.findUniqueOrThrow({ where: { id: foreign.id } })).status
      ).toBe(PurchaseOrderStatus.DRAFT)
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
  // The events the search leaves (`analytics_events`) have two readers: the report of what was searched, and the writer of the
  // worker. The report filters by the store of the header in each statement; the click route queues for that store only.
  describe('search analytics', () => {
    const word = `srca${randomUUID().slice(0, 6)}`
    const hashOfB = 'b'.repeat(16)

    afterEach(async () => {
      await owner.analyticsEvent.deleteMany({ where: { storeId: ctx.storeB.id } })
    })

    it('reports only the events of the store of the header, never those of another store', async () => {
      await owner.analyticsEvent.create({
        data: {
          storeId: ctx.storeB.id,
          event: AnalyticsEventNames.SEARCH_PERFORMED,
          data: {
            queryHash: hashOfB,
            scope: 'products',
            resultCount: 0,
            durationMs: 3,
            query: `${word} gap`
          },
          date: new Date(),
          eventKey: randomUUID()
        }
      })
      const foreign = await api(app, ctx.adminA, ctx.storeA).get(ApiRoutes.analytics.search)
      expect(foreign.status).toBe(200)
      const bodyA = foreign.body as { zeroResultQueries: { query: string }[] }
      expect(bodyA.zeroResultQueries.map(row => row.query)).not.toContain(`${word} gap`)
      // The owner of the data does read it, so the answer above is not an empty table
      const own = await api(app, ctx.adminB, ctx.storeB).get(ApiRoutes.analytics.search)
      expect((own.body as typeof bodyA).zeroResultQueries.map(row => row.query)).toContain(
        `${word} gap`
      )
    })

    it('does not take the store from the query string or from the store of another member', async () => {
      const forged = await api(app, ctx.adminA, ctx.storeA)
        .get(ApiRoutes.analytics.search)
        .query({ storeId: ctx.storeB.id })
      expect(forged.status).toBe(400)
      // The header of a store the member does not belong to is refused before the report runs
      const other = await api(app, ctx.adminA, ctx.storeB).get(ApiRoutes.analytics.search)
      expect(other.status).toBe(403)
      const click = await api(app, ctx.adminA, ctx.storeB)
        .post(ApiRoutes.search.clicks)
        .send({ q: `${word} click`, scope: 'global', entity: 'customers', position: 0 })
      expect(click.status).toBe(403)
    })
  })

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
  // The public one-click unsubscribe has no session, so no store and no person in the request: what separates people is the id inside a
  // signed token, and the context of that one person (JobContext.forUser) that the write runs in
  describe('the one-click unsubscribe of the notification emails', () => {
    const emailOf = async (userId: string, storeId: string) => {
      await owner.userNotificationSettings.upsert({
        where: { userId },
        create: { userId, digestFrequency: 'hourly' },
        update: { digestFrequency: 'hourly' }
      })
      return owner.notification.create({
        data: {
          userId,
          storeId,
          type: NotificationTypes.EXPORT_READY,
          severity: NotificationSeverity.INFO,
          messageKey: notificationMessageKey(NotificationTypes.EXPORT_READY),
          emailPendingAt: new Date()
        },
        select: { id: true }
      })
    }

    it('switches off the email of the person the token names and touches nobody of another store or organization', async () => {
      const key =
        app.get<readonly string[]>(UNSUBSCRIBE_VERIFICATION_KEYS, { strict: false })[0] ?? ''
      const mineA = await emailOf(ctx.adminA.id, ctx.storeA.id)
      const mineB = await emailOf(ctx.adminB.id, ctx.storeB.id)

      const done = await anonymousApi(app)
        .post(ApiRoutes.notifications.unsubscribe)
        .send({
          token: signUnsubscribeToken(key, UnsubscribeScopes.NOTIFICATION_EMAIL, ctx.adminA.id)
        })

      expect(done.status).toBe(204)
      const own = await owner.userNotificationSettings.findUnique({
        where: { userId: ctx.adminA.id }
      })
      expect(own?.digestFrequency).toBe('off')
      expect(
        (await owner.notification.findUniqueOrThrow({ where: { id: mineA.id } })).emailPendingAt
      ).toBeNull()
      // The person of the other organization: the same choice, the same mark
      const other = await owner.userNotificationSettings.findUnique({
        where: { userId: ctx.adminB.id }
      })
      expect(other?.digestFrequency).toBe('hourly')
      expect(
        (await owner.notification.findUniqueOrThrow({ where: { id: mineB.id } })).emailPendingAt
      ).not.toBeNull()
    })

    it('does not let a person switch off the email of another by changing the id of the token', async () => {
      const key =
        app.get<readonly string[]>(UNSUBSCRIBE_VERIFICATION_KEYS, { strict: false })[0] ?? ''
      await emailOf(ctx.adminA.id, ctx.storeA.id)
      await emailOf(ctx.adminB.id, ctx.storeB.id)
      const [version, scope, , mac] = signUnsubscribeToken(
        key,
        UnsubscribeScopes.NOTIFICATION_EMAIL,
        ctx.adminA.id
      ).split('.') as [string, string, string, string]

      // The mac of A's token with the id of B in it: it verifies for nobody
      const forged = await anonymousApi(app)
        .post(ApiRoutes.notifications.unsubscribe)
        .send({ token: [version, scope, ctx.adminB.id, mac].join('.') })

      expect(forged.status).toBe(204)
      const victim = await owner.userNotificationSettings.findUnique({
        where: { userId: ctx.adminB.id }
      })
      expect(victim?.digestFrequency).toBe('hourly')
      expect(
        await owner.notification.count({
          where: { userId: ctx.adminB.id, emailPendingAt: { not: null } }
        })
      ).toBeGreaterThan(0)
    })
  })

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

      const directory = await allDirectoryRows(query =>
        api(app, ctx.adminA, ctx.storeA).get(ApiRoutes.channels.directory).query(query)
      )

      expect(directory.status).toBe(200)
      expect(JSON.stringify(directory.rows)).toContain(connectionA.id)
      expect(JSON.stringify(directory.rows)).not.toContain(connectionB.id)
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
      expect(
        (
          list.body as { figures: { byCurrency: { totalSpentCents: number }[] } }
        ).figures.byCurrency.map(line => line.totalSpentCents)
      ).toEqual([1000])
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

  // The key of an installation (Step 5.6, P2) is one store's: the plugin API names the store from the key, and nothing the call
  // carries (a header, a query) changes it. The installation is the resource, `pluginInstallation` above covers revoking it by id.
  describe('the key of a plugin installation', () => {
    const pluginId = `${prefix}-keyed`
    const keys: Record<'a' | 'a2' | 'b', string> = { a: '', a2: '', b: '' }
    const stores = () => ({ a: ctx.storeA, a2: ctx.storeA2, b: ctx.storeB })

    beforeAll(async () => {
      await owner.plugin.create({
        data: {
          id: pluginId,
          name: 'Keyed plugin',
          authorName: 'suite',
          authorEmail: 'suite@example.invalid',
          type: PluginCatalogTypes.INTEGRATION,
          manifest: {},
          pricingModel: PluginPricingModels.FREE,
          status: PluginStatus.APPROVED,
          organizationId: ctx.orgA.id
        }
      })
      for (const [name, store] of Object.entries(stores()) as [
        'a' | 'a2' | 'b',
        { id: string }
      ][]) {
        const key = `${PLUGIN_API_KEY_TOKEN_PREFIX}${name}${'x'.repeat(40)}`
        keys[name] = key
        // Installed as the setup exchange leaves it: active, with the hash of the key only
        await owner.pluginInstallation.create({
          data: {
            storeId: store.id,
            pluginId,
            scopes: [],
            status: 'active',
            apiKeyPrefix: key.slice(0, 12),
            apiKeyHash: createHash('sha256').update(key).digest('hex'),
            installedBy: 'suite'
          }
        })
      }
    })
    afterAll(async () => {
      await owner.pluginInstallation.deleteMany({ where: { pluginId } })
      await owner.plugin.deleteMany({ where: { id: pluginId } })
    })

    const whoIs = (key: string) =>
      supertest(app.getHttpServer() as Parameters<typeof supertest>[0])
        .get(`${API_PREFIX}${PluginApiRoutes.installation}`)
        .set('authorization', `Bearer ${key}`)

    it('names the store of its own installation, and the sibling and foreign stores each their own', async () => {
      for (const [name, store] of Object.entries(stores())) {
        const response = await whoIs(keys[name as 'a' | 'a2' | 'b'])
        expect(response.status).toBe(200)
        expect((response.body as { storeId: string }).storeId).toBe(store.id)
      }
    })

    it('is not moved to another store by a header, a query or a body that names one', async () => {
      const moved = await whoIs(keys.a)
        .set('x-store-id', ctx.storeB.id)
        .query({ storeId: ctx.storeB.id })
        .send({ storeId: ctx.storeB.id })

      expect(moved.status).toBe(200)
      expect((moved.body as { storeId: string }).storeId).toBe(ctx.storeA.id)
    })
  })

  // The idempotency key of a write of a plugin (Step 7.3, S4) belongs to ONE installation: the same key of the installation of another
  // store, of this organization or of another, is a different key, and what a call answered is never replayed to them. The plugin is
  // official (no organization; the catalog only allows that for a channel) so that its installations can sit in stores of two
  // organizations, as in the block of the channel routes.
  // `pluginIdempotencyKey` is the resource.
  describe('the idempotency keys of the plugin API', () => {
    const pluginId = `${prefix}-idem`
    const keyOf: Record<'a' | 'a2' | 'b', string> = { a: '', a2: '', b: '' }
    const installationOf: Record<'a' | 'a2' | 'b', string> = { a: '', a2: '', b: '' }
    const storeIdOf = (name: 'a' | 'a2' | 'b') =>
      ({ a: ctx.storeA, a2: ctx.storeA2, b: ctx.storeB })[name].id
    const sharedKey = `isolation-${randomUUID()}`
    const create = (name: 'a' | 'a2' | 'b', tag: string, key: string = sharedKey) =>
      supertest(app.getHttpServer() as Parameters<typeof supertest>[0])
        .post(`${API_PREFIX}${PluginApiRoutes.settings.tags}`)
        .set('authorization', `Bearer ${keyOf[name]}`)
        .set('idempotency-key', key)
        .set('x-forwarded-for', `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`)
        .send({ name: tag })

    beforeAll(async () => {
      await owner.plugin.create({
        data: {
          id: pluginId,
          name: 'Idempotent plugin',
          authorName: 'suite',
          authorEmail: 'suite@example.invalid',
          type: PluginCatalogTypes.CHANNEL,
          manifest: {},
          pricingModel: PluginPricingModels.FREE,
          status: PluginStatus.APPROVED,
          organizationId: null
        }
      })
      for (const name of ['a', 'a2', 'b'] as const) {
        const key = `${PLUGIN_API_KEY_TOKEN_PREFIX}${prefix}idem${name}${'y'.repeat(40)}`
        keyOf[name] = key
        const installation = await owner.pluginInstallation.create({
          data: {
            storeId: storeIdOf(name),
            pluginId,
            scopes: [PluginScopes.TAGS_READ, PluginScopes.TAGS_WRITE],
            status: 'active',
            apiKeyPrefix: key.slice(0, 12),
            apiKeyHash: createHash('sha256').update(key).digest('hex'),
            installedBy: 'suite'
          }
        })
        installationOf[name] = installation.id
      }
    })
    afterAll(async () => {
      await owner.tag.deleteMany({ where: { name: { startsWith: `${prefix}-idem-` } } })
      await owner.pluginInstallation.deleteMany({ where: { pluginId } })
      await owner.plugin.deleteMany({ where: { id: pluginId } })
    })

    it('answers the same key of one installation with the first answer and makes the write once', async () => {
      const name = `${prefix}-idem-once`
      const first = await create('a', name)
      const again = await create('a', name)

      expect(first.status).toBe(201)
      expect(again.status).toBe(201)
      expect(again.header['idempotent-replayed']).toBe('true')
      expect(again.body).toEqual(first.body)
      expect(await owner.tag.count({ where: { storeId: ctx.storeA.id, name } })).toBe(1)
    })

    it('does not replay the answer of one installation to the same key of a sibling store or of a foreign one', async () => {
      const key = `isolation-${randomUUID()}`
      const mine = await create('a', `${prefix}-idem-own`, key)
      expect(mine.status).toBe(201)
      for (const other of ['a2', 'b'] as const) {
        const theirs = await create(other, `${prefix}-idem-${other}`, key)
        expect(theirs.status).toBe(201)
        expect(theirs.header['idempotent-replayed']).toBeUndefined()
        expect((theirs.body as { id: string }).id).not.toBe((mine.body as { id: string }).id)
        expect(
          await owner.tag.count({
            where: { storeId: storeIdOf(other), name: `${prefix}-idem-${other}` }
          })
        ).toBe(1)
      }
      const rows = await owner.pluginIdempotencyKey.findMany({
        where: { key },
        select: { storeId: true, installationId: true, state: true }
      })
      expect(rows).toHaveLength(3)
      for (const name of ['a', 'a2', 'b'] as const) {
        expect(rows).toContainEqual({
          storeId: storeIdOf(name),
          installationId: installationOf[name],
          state: 'completed'
        })
      }
    })

    it('is not returned and does not make wait the same key of another plugin in the same store, or of another store, while the first call runs', async () => {
      const key = `isolation-${randomUUID()}`
      const otherPlugin = `${pluginId}-two`
      await owner.plugin.create({
        data: {
          id: otherPlugin,
          name: 'Second idempotent plugin',
          authorName: 'suite',
          authorEmail: 'suite@example.invalid',
          type: PluginCatalogTypes.CHANNEL,
          manifest: {},
          pricingModel: PluginPricingModels.FREE,
          status: PluginStatus.APPROVED,
          organizationId: null
        }
      })
      const secondKey = `${PLUGIN_API_KEY_TOKEN_PREFIX}${prefix}idemtwo${'w'.repeat(40)}`
      await owner.pluginInstallation.create({
        data: {
          storeId: ctx.storeA.id,
          pluginId: otherPlugin,
          scopes: [PluginScopes.TAGS_READ, PluginScopes.TAGS_WRITE],
          status: 'active',
          apiKeyPrefix: secondKey.slice(0, 12),
          apiKeyHash: createHash('sha256').update(secondKey).digest('hex'),
          installedBy: 'suite'
        }
      })
      try {
        // The call of installation `a` is still running: its claim is there and not closed
        await owner.pluginIdempotencyKey.create({
          data: {
            storeId: ctx.storeA.id,
            installationId: installationOf.a,
            key,
            requestHash: 'running',
            state: 'in_progress',
            expiresAt: new Date(Date.now() + 3_600_000)
          }
        })

        const sameStoreOtherPlugin = await supertest(
          app.getHttpServer() as Parameters<typeof supertest>[0]
        )
          .post(`${API_PREFIX}${PluginApiRoutes.settings.tags}`)
          .set('authorization', `Bearer ${secondKey}`)
          .set('idempotency-key', key)
          .set('x-forwarded-for', `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`)
          .send({ name: `${prefix}-idem-other-plugin` })
        const otherStore = await create('b', `${prefix}-idem-other-store`, key)

        expect(sameStoreOtherPlugin.status).toBe(201)
        expect(sameStoreOtherPlugin.header['idempotent-replayed']).toBeUndefined()
        expect(otherStore.status).toBe(201)
        expect(otherStore.header['idempotent-replayed']).toBeUndefined()
        // And the claim that was running is still the one of `a`, untouched
        expect(
          await owner.pluginIdempotencyKey.count({
            where: { key, installationId: installationOf.a, state: 'in_progress' }
          })
        ).toBe(1)
      } finally {
        await owner.pluginInstallation.deleteMany({ where: { pluginId: otherPlugin } })
        await owner.plugin.deleteMany({ where: { id: otherPlugin } })
      }
    })

    it('refuses the key of the installation for another request instead of answering with the first', async () => {
      const key = `isolation-${randomUUID()}`
      expect((await create('a', `${prefix}-idem-one`, key)).status).toBe(201)
      const other = await create('a', `${prefix}-idem-two`, key)

      expect(other.status).toBe(409)
      expect(
        (other.body as { error: { metadata?: { reason?: string } } }).error.metadata?.reason
      ).toBe('idempotency_key_reused')
      expect(await owner.tag.count({ where: { name: `${prefix}-idem-two` } })).toBe(0)
    })
  })

  // The connections and events of a remote channel plugin (Step 5.6, C3): the key of one installation reaches the connections of that
  // installation and of no other, in its own store or in another. `channelConnection` and `pluginInstallation` are the resources.
  // The plugin of this block is OFFICIAL (no organization): one plugin installed in stores of two organizations is the state that proves the
  // isolation between installations. What a PRIVATE plugin of one organization does in a store of another (refused at install by
  // plugin-installations.service.ts, hidden from that store by the row policy of `plugins`) is not tried here.
  describe('the channel routes of the plugin API', () => {
    const pluginId = `${prefix}-chan`
    const channelScopes = [PluginScopes.CHANNEL_CONNECTIONS, PluginScopes.CHANNEL_EVENTS]
    const keyOf: Record<'a' | 'a2' | 'b', string> = { a: '', a2: '', b: '' }
    const installationOf: Record<'a' | 'a2' | 'b', string> = { a: '', a2: '', b: '' }
    const connectionOf: Record<'a' | 'b', string> = { a: '', b: '' }
    const call = (method: 'put' | 'delete' | 'post', path: string, key: string) =>
      supertest(app.getHttpServer() as Parameters<typeof supertest>[0])
        [method](`${API_PREFIX}${path}`)
        .set('authorization', `Bearer ${key}`)
        .set('x-forwarded-for', `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`)

    beforeAll(async () => {
      await owner.plugin.create({
        data: {
          id: pluginId,
          name: 'Channel plugin',
          authorName: 'suite',
          authorEmail: 'suite@example.invalid',
          type: PluginCatalogTypes.CHANNEL,
          manifest: {},
          pricingModel: PluginPricingModels.FREE,
          status: PluginStatus.APPROVED,
          // An official plugin (no organization): the three installations below are in stores of TWO organizations, and the product refuses to
          // install the private plugin of one organization in a store of another (plugin-installations.service.ts). A private plugin of
          // organization A is hidden by the row policy from a request of store B, so the key of B would be answered 401 before the
          // isolation between the installations is ever tried
          organizationId: null
        }
      })
      for (const [name, store] of [
        ['a', ctx.storeA],
        ['a2', ctx.storeA2],
        ['b', ctx.storeB]
      ] as const) {
        const key = `${PLUGIN_API_KEY_TOKEN_PREFIX}${prefix}chan${name}${'z'.repeat(40)}`
        keyOf[name] = key
        const installation = await owner.pluginInstallation.create({
          data: {
            storeId: store.id,
            pluginId,
            scopes: channelScopes,
            status: 'active',
            apiKeyPrefix: key.slice(0, 12),
            apiKeyHash: createHash('sha256').update(key).digest('hex'),
            installedBy: 'suite'
          }
        })
        installationOf[name] = installation.id
      }
      for (const name of ['a', 'b'] as const) {
        const created = await call(
          'put',
          PluginApiRoutes.channel.connection(`acct-${name}`),
          keyOf[name]
        ).send({
          displayName: `Account ${name}`
        })
        expect(created.status).toBe(201)
        connectionOf[name] = (
          await owner.channelConnection.findUniqueOrThrow({
            where: { pluginId_connectionId: { pluginId, connectionId: `acct-${name}` } }
          })
        ).id
      }
    })
    afterAll(async () => {
      await owner.channelConnection.deleteMany({ where: { pluginId } })
      await owner.pluginInstallation.deleteMany({ where: { pluginId } })
      await owner.plugin.deleteMany({ where: { id: pluginId } })
    })

    it('makes each connection in the store and under the installation of its own key', async () => {
      const rows = await owner.channelConnection.findMany({
        where: { pluginId },
        select: { id: true, storeId: true, installationId: true }
      })
      expect(rows).toHaveLength(2)
      expect(rows.find(row => row.id === connectionOf.a)).toMatchObject({
        storeId: ctx.storeA.id,
        installationId: installationOf.a
      })
      expect(rows.find(row => row.id === connectionOf.b)).toMatchObject({
        storeId: ctx.storeB.id,
        installationId: installationOf.b
      })
    })

    it('does not let the key of a sibling store or of a foreign one disconnect, rename or take the connection of another', async () => {
      for (const key of [keyOf.a2, keyOf.b]) {
        const removed = await call('delete', PluginApiRoutes.channel.connection('acct-a'), key)
        expect(removed.status).toBe(404)
        const taken = await call('put', PluginApiRoutes.channel.connection('acct-a'), key).send({
          displayName: 'Hijacked'
        })
        expect(taken.status).toBe(409)
      }
      expect(
        await owner.channelConnection.findUniqueOrThrow({
          where: { id: connectionOf.a },
          select: { storeId: true, installationId: true, displayName: true, status: true }
        })
      ).toEqual({
        storeId: ctx.storeA.id,
        installationId: installationOf.a,
        displayName: 'Account a',
        status: 'active'
      })
    })

    it('refuses the events of a request that names a connection of another store, and says the same as for one that is not there', async () => {
      const event = (connectionId: string) => ({
        type: 'message_received',
        connectionId,
        channelIdentity: 'customer-1',
        message: {
          externalId: `m-${randomUUID()}`,
          type: MessageType.TEXT,
          content: 'hello',
          timestamp: new Date().toISOString()
        },
        timestamp: new Date().toISOString()
      })
      const foreign = await call('post', PluginApiRoutes.channel.events, keyOf.a).send({
        events: [event('acct-b')]
      })
      const absent = await call('post', PluginApiRoutes.channel.events, keyOf.a).send({
        events: [event('acct-nobody')]
      })
      expect(foreign.status).toBe(404)
      expect(absent.status).toBe(404)
      expect((foreign.body as { error: { code: string } }).error).toEqual(
        (absent.body as { error: { code: string } }).error
      )
    })

    it('leaves the installation of the other store as it was', async () => {
      const row = await owner.pluginInstallation.findUniqueOrThrow({
        where: { id: installationOf.b },
        select: { storeId: true, status: true, scopes: true }
      })
      expect(row).toEqual({ storeId: ctx.storeB.id, status: 'active', scopes: channelScopes })
    })
  })

  // The webhooks of a plugin installation (Step 5.6, P3) are one store's: an event of a store is queued only for the installations
  // of that store, and a delivery reads its installation under the store of its job.
  describe('the webhooks of a plugin installation', () => {
    const pluginId = `${prefix}-hooked`
    const installationOf: Record<'a' | 'b', string> = { a: '', b: '' }

    beforeAll(async () => {
      await owner.plugin.create({
        data: {
          id: pluginId,
          name: 'Hooked plugin',
          authorName: 'suite',
          authorEmail: 'suite@example.invalid',
          type: PluginCatalogTypes.INTEGRATION,
          manifest: {
            webhooks: {
              endpoint: 'https://hooks.example.com/in',
              events: [Events.ORDER_CREATED],
              signatureHeader: 'X-Suite-Signature'
            }
          },
          pricingModel: PluginPricingModels.FREE,
          status: PluginStatus.APPROVED,
          organizationId: ctx.orgA.id
        }
      })
      for (const [name, store] of [
        ['a', ctx.storeA],
        ['b', ctx.storeB]
      ] as const) {
        const row = await owner.pluginInstallation.create({
          data: {
            storeId: store.id,
            pluginId,
            scopes: [PluginScopes.ORDERS_READ],
            status: 'active',
            webhookEndpoint: 'https://hooks.example.com/in',
            webhookSecret: new Uint8Array([1, 2, 3]),
            installedBy: 'suite'
          }
        })
        installationOf[name] = row.id
      }
    })
    afterAll(async () => {
      await owner.pluginInstallation.deleteMany({ where: { pluginId } })
      await owner.plugin.deleteMany({ where: { id: pluginId } })
    })

    it('queues an event of a store for the installation of that store only', async () => {
      const queue = queueOf(app, QueueNames.WEBHOOKS)
      queue.jobs.length = 0

      await app.get(WebhookDispatcher).dispatch(Events.ORDER_CREATED, {
        storeId: ctx.storeA.id,
        orderId: randomUUID(),
        orderNumber: '1001'
      })

      const targets = queue.jobs
        .filter(job => job.name === JobNames.TRIGGER_PLUGIN_WEBHOOK)
        .map(job => (job.data as { pluginInstallationId: string }).pluginInstallationId)
      expect(targets).toEqual([installationOf.a])
      queue.jobs.length = 0
    })
  })

  // The messages a plugin reads and writes (Step 5.6, M1b): the key of one store reaches the conversations and messages of that store
  // and of no other, whatever the call carries. The conversation and the message are the resources.
  describe('the messages of the plugin API', () => {
    const pluginId = `${prefix}-msgkey`
    const scopes = [
      'conversations:read',
      'messages:read',
      'messages:write',
      'messages:delete',
      'messages:read-deleted'
    ]
    const keyOfB = `${PLUGIN_API_KEY_TOKEN_PREFIX}${prefix}msgb${'y'.repeat(40)}`
    let conversationA = ''
    let messageA = ''
    // A live message of store A that carries THIS plugin's id as its author: the id alone is no reach into another store
    let liveA = ''

    beforeAll(async () => {
      await owner.plugin.create({
        data: {
          id: pluginId,
          name: 'Message plugin',
          authorName: 'suite',
          authorEmail: 'suite@example.invalid',
          type: PluginCatalogTypes.INTEGRATION,
          manifest: {},
          pricingModel: PluginPricingModels.FREE,
          status: PluginStatus.APPROVED,
          organizationId: ctx.orgA.id
        }
      })
      await owner.pluginInstallation.create({
        data: {
          storeId: ctx.storeB.id,
          pluginId,
          scopes,
          status: 'active',
          apiKeyPrefix: keyOfB.slice(0, 12),
          apiKeyHash: createHash('sha256').update(keyOfB).digest('hex'),
          installedBy: 'suite'
        }
      })
      conversationA = (await createConversationOf(owner, { storeId: ctx.storeA.id })).id
      messageA = (
        await owner.message.create({
          data: {
            storeId: ctx.storeA.id,
            conversationId: conversationA,
            type: 'text',
            authorType: 'agent',
            content: 'of store A',
            deletedAt: new Date()
          }
        })
      ).id
      liveA = (
        await owner.message.create({
          data: {
            storeId: ctx.storeA.id,
            conversationId: conversationA,
            type: 'text',
            authorType: 'system',
            authorPluginId: pluginId,
            content: 'live of store A',
            channelMessageId: `wamid-${randomUUID()}`,
            deliveryStatus: 'failed',
            failureDefinitive: true
          }
        })
      ).id
    })
    afterAll(async () => {
      await owner.pluginInstallation.deleteMany({ where: { pluginId } })
      await owner.plugin.deleteMany({ where: { id: pluginId } })
    })

    const asB = (method: 'get' | 'post' | 'patch' | 'delete' | 'put', path: string) =>
      supertest(app.getHttpServer() as Parameters<typeof supertest>[0])
        [method](`${API_PREFIX}${path}`)
        .set('authorization', `Bearer ${keyOfB}`)

    it('works in its own store, so that the 404 of the others means "foreign"', async () => {
      const own = (await createConversationOf(owner, { storeId: ctx.storeB.id })).id

      const response = await asB('post', PluginApiRoutes.messages.create).send({
        type: 'text',
        conversationId: own,
        content: 'from the own store',
        idempotencyKey: randomUUID()
      })

      expect(response.status).toBe(201)
    })

    it('does not write into a conversation of another store, even with the id and the header of that store', async () => {
      const response = await asB('post', PluginApiRoutes.messages.create)
        .set('x-store-id', ctx.storeA.id)
        .send({
          type: 'text',
          conversationId: conversationA,
          content: 'from the other store',
          idempotencyKey: randomUUID()
        })

      expect(response.status).toBe(404)
      expect(
        await owner.message.count({
          where: { conversationId: conversationA, content: 'from the other store' }
        })
      ).toBe(0)
    })

    it('does not read the edits or the kept text of a message of another store', async () => {
      const edits = await asB('get', PluginApiRoutes.messages.revisions(messageA))
      const kept = await asB('get', PluginApiRoutes.messages.deletedContent(messageA))

      expect(edits.status).toBe(404)
      expect(kept.status).toBe(404)
      expect(JSON.stringify([edits.body, kept.body])).not.toContain('of store A')
    })

    // Step 5.6, M1c: the changes a plugin makes (edit, delete, send again, discard, react) answer 404 for a message of another store,
    // and change nothing there, though the message names this very plugin as its author
    it('does not edit, delete, send again, discard or react to a message of another store', async () => {
      const edit = await asB('patch', PluginApiRoutes.messages.byId(liveA)).send({
        content: 'taken over'
      })
      const remove = await asB('delete', PluginApiRoutes.messages.byId(liveA))
      const resend = await asB('post', PluginApiRoutes.messages.resend(liveA)).send({})
      const discard = await asB('post', PluginApiRoutes.messages.discard(liveA)).send({})
      const react = await asB('put', PluginApiRoutes.messages.reaction(liveA)).send({
        emoji: '👍'
      })

      for (const response of [edit, remove, resend, discard, react]) {
        expect(response.status).toBe(404)
      }
      expect(await owner.message.findUniqueOrThrow({ where: { id: liveA } })).toMatchObject({
        content: 'live of store A',
        deliveryStatus: 'failed',
        deletedAt: null,
        discardedAt: null,
        deleteStatus: null,
        pendingContent: null,
        editedByPluginId: null,
        deletedByPluginId: null
      })
      expect(await owner.messageReaction.count({ where: { messageId: liveA } })).toBe(0)
    })
  })

  // The customers a plugin reads and changes (Step 5.6, E2): the key of one store reaches the customers of that store and of no
  // other, whatever the call carries. The customer, with its contact data, is the resource.
  describe('the customers of the plugin API', () => {
    const pluginId = `${prefix}-custkey`
    const scopes = [
      'customers:read',
      'customers:write',
      'customers:delete',
      'customers:flag-caution',
      'orders:read',
      'conversations:read'
    ]
    const keyOfB = `${PLUGIN_API_KEY_TOKEN_PREFIX}${prefix}custb${'z'.repeat(40)}`
    let customerA = ''

    beforeAll(async () => {
      await owner.plugin.create({
        data: {
          id: pluginId,
          name: 'Customer plugin',
          authorName: 'suite',
          authorEmail: 'suite@example.invalid',
          type: PluginCatalogTypes.INTEGRATION,
          manifest: {},
          pricingModel: PluginPricingModels.FREE,
          status: PluginStatus.APPROVED,
          organizationId: ctx.orgA.id
        }
      })
      await owner.pluginInstallation.create({
        data: {
          storeId: ctx.storeB.id,
          pluginId,
          scopes,
          status: 'active',
          apiKeyPrefix: keyOfB.slice(0, 12),
          apiKeyHash: createHash('sha256').update(keyOfB).digest('hex'),
          installedBy: 'suite'
        }
      })
      customerA = (await createCustomer(owner, { storeId: ctx.storeA.id, name: 'of store A' })).id
    })
    afterAll(async () => {
      await owner.pluginInstallation.deleteMany({ where: { pluginId } })
      await owner.plugin.deleteMany({ where: { id: pluginId } })
    })

    const asB = (method: 'get' | 'post' | 'patch' | 'put' | 'delete', path: string) =>
      supertest(app.getHttpServer() as Parameters<typeof supertest>[0])
        [method](`${API_PREFIX}${path}`)
        .set('authorization', `Bearer ${keyOfB}`)
        .set('x-store-id', ctx.storeA.id)

    it('works in its own store, so that the 404 of the others means "foreign"', async () => {
      const own = (await createCustomer(owner, { storeId: ctx.storeB.id })).id

      const response = await asB('get', PluginApiRoutes.customers.byId(own))

      expect(response.status).toBe(200)
    })

    it('does not list, read, change, flag or delete a customer of another store, even with the id and the header of that store', async () => {
      const listed = await asB('get', PluginApiRoutes.customers.list)
      const read = await asB('get', PluginApiRoutes.customers.byId(customerA))
      const changed = await asB('patch', PluginApiRoutes.customers.byId(customerA)).send({
        name: 'hacked'
      })
      const flagged = await asB('put', PluginApiRoutes.customers.caution(customerA)).send({
        reason: 'hacked'
      })
      const deleted = await asB('delete', PluginApiRoutes.customers.byId(customerA))

      expect(JSON.stringify(listed.body)).not.toContain(customerA)
      for (const response of [read, changed, flagged, deleted]) expect(response.status).toBe(404)
      const after = await owner.customer.findUniqueOrThrow({ where: { id: customerA } })
      expect(after.name).toBe('of store A')
      expect(after.isCaution).toBe(false)
    })

    it('does not read what hangs from a customer of another store', async () => {
      const responses = [
        await asB('get', PluginApiRoutes.customers.timeline(customerA)),
        await asB('get', PluginApiRoutes.customers.orders(customerA)),
        await asB('get', PluginApiRoutes.customers.conversations(customerA)),
        await asB('get', PluginApiRoutes.customers.notes(customerA))
      ]

      for (const response of responses) {
        expect(response.status).toBe(404)
        expect(JSON.stringify(response.body)).not.toContain('of store A')
      }
    })

    it('does not add an address or a handle to a customer of another store', async () => {
      const address = await asB('post', PluginApiRoutes.customers.addresses(customerA)).send({
        line1: 'x',
        city: 'y',
        country: 'SV'
      })
      const handle = await asB('post', PluginApiRoutes.customers.identities(customerA)).send({
        channelType: 'instagram',
        channelIdentity: 'someone'
      })

      expect(address.status).toBe(404)
      expect(handle.status).toBe(404)
      expect(await owner.address.count({ where: { customerId: customerA } })).toBe(0)
      expect(await owner.customerIdentity.count({ where: { customerId: customerA } })).toBe(0)
    })
  })

  // What a plugin key reads of the orders (Step 5.6, E3a): the key of store B reads the orders, their message history, the templates
  // and the settings of store B, and an order of store A is an order that does not exist for it, by id or in a list.
  describe('the orders read with the key of a plugin', () => {
    const pluginId = `${prefix}-ordread`
    let keyOfB = ''
    let orderA = ''
    let orderB = ''

    beforeAll(async () => {
      ;({ key: keyOfB } = await createPluginKey(owner, {
        storeId: ctx.storeB.id,
        pluginId,
        scopes: [
          PluginScopes.ORDERS_READ,
          PluginScopes.ORDER_MESSAGES_READ,
          PluginScopes.SETTINGS_READ
        ]
      }))
      orderA = (await createOrder(owner, { storeId: ctx.storeA.id })).id
      orderB = (await createOrder(owner, { storeId: ctx.storeB.id })).id
    })
    afterAll(async () => {
      await owner.pluginInstallation.deleteMany({ where: { pluginId } })
      await owner.plugin.deleteMany({ where: { id: pluginId } })
    })

    const asB = (path: string) =>
      supertest(app.getHttpServer() as Parameters<typeof supertest>[0])
        .get(`${API_PREFIX}${path}`)
        .set('authorization', `Bearer ${keyOfB}`)

    it('works in its own store, so that the 404 of the others means "foreign"', async () => {
      expect((await asB(PluginApiRoutes.orders.byId(orderB))).status).toBe(200)
      expect((await asB(PluginApiRoutes.orders.messages(orderB))).status).toBe(200)
      expect((await asB(PluginApiRoutes.settings.preferences)).status).toBe(200)
    })

    it('does not read an order of another store, nor its messages, and does not list it', async () => {
      const detail = await asB(PluginApiRoutes.orders.byId(orderA))
      const messages = await asB(PluginApiRoutes.orders.messages(orderA))
      const list = await asB(PluginApiRoutes.orders.list)

      expect(detail.status).toBe(404)
      expect(messages.status).toBe(404)
      expect(list.status).toBe(200)
      expect(JSON.stringify(list.body)).not.toContain(orderA)
    })
  })

  // What a plugin key writes of the orders (Step 5.6, E3b): the key of store B creates, edits, confirms, cancels, pays and decides the
  // price of orders of store B, and an order of store A, a customer of store A and a product of store A are rows that do not exist for
  // it, whatever the id it names. Nothing of store A changes.
  describe('the orders written with the key of a plugin', () => {
    const pluginId = `${prefix}-ordwrite`
    let keyOfB = ''
    let orderA = ''
    let customerA = ''
    let productA = ''
    let customerB = ''
    let productB = ''

    beforeAll(async () => {
      ;({ key: keyOfB } = await createPluginKey(owner, {
        storeId: ctx.storeB.id,
        pluginId,
        scopes: [
          PluginScopes.ORDERS_READ,
          PluginScopes.ORDERS_WRITE,
          PluginScopes.ORDERS_EDIT,
          PluginScopes.ORDERS_CONFIRM,
          PluginScopes.ORDERS_CANCEL,
          PluginScopes.ORDERS_APPROVE_PRICE,
          PluginScopes.ORDER_MESSAGES_WRITE
        ]
      }))
      orderA = (await createOrder(owner, { storeId: ctx.storeA.id })).id
      customerA = (await createCustomer(owner, { storeId: ctx.storeA.id })).id
      productA = (await createProduct(owner, { storeId: ctx.storeA.id })).id
      customerB = (await createCustomer(owner, { storeId: ctx.storeB.id })).id
      productB = (await createProduct(owner, { storeId: ctx.storeB.id })).id
    })
    afterAll(async () => {
      await owner.pluginInstallation.deleteMany({ where: { pluginId } })
      await owner.plugin.deleteMany({ where: { id: pluginId } })
    })

    const asB = (method: 'post' | 'patch', path: string) =>
      supertest(app.getHttpServer() as Parameters<typeof supertest>[0])
        [method](`${API_PREFIX}${path}`)
        .set('authorization', `Bearer ${keyOfB}`)

    it('does not create an order for a customer or with a product of another store', async () => {
      const body = {
        items: [{ productId: productB, quantity: 1 }],
        paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
        recipientPhones: ['71234567']
      }
      const foreignCustomer = await asB('post', PluginApiRoutes.orders.create).send({
        ...body,
        customerId: customerA
      })
      const foreignProduct = await asB('post', PluginApiRoutes.orders.create).send({
        ...body,
        customerId: customerB,
        items: [{ productId: productA, quantity: 1 }]
      })

      expect(foreignCustomer.status).toBe(404)
      expect(foreignProduct.status).toBe(404)
      expect(
        await owner.order.count({ where: { storeId: ctx.storeB.id, createdByPluginId: pluginId } })
      ).toBe(0)
    })

    it('does not edit, change, confirm, cancel, pay, decide the price of or send a message about an order of another store', async () => {
      const writes = [
        asB('patch', PluginApiRoutes.orders.byId(orderA)).send({ shippingCents: 1 }),
        asB('post', PluginApiRoutes.orders.status(orderA)).send({ status: OrderStatus.PREPARING }),
        asB('post', PluginApiRoutes.orders.confirm(orderA)).send({
          via: OrderConfirmationChannel.CALL
        }),
        asB('post', PluginApiRoutes.orders.cancel(orderA)).send({ cancellationReason: 'x' }),
        asB('post', PluginApiRoutes.orders.payment(orderA)).send({
          method: PaymentMethod.CASH,
          status: PaymentStatus.COMPLETED
        }),
        asB('post', PluginApiRoutes.orders.priceApprovalApprove(orderA)).send({}),
        asB('post', PluginApiRoutes.orders.priceApprovalReject(orderA)).send({}),
        asB('post', PluginApiRoutes.orders.messages(orderA)).send({
          kind: OrderMessageKind.ORDER_SHIPPED,
          idempotencyKey: randomUUID()
        }),
        asB('post', PluginApiRoutes.orders.confirmBulk).send({
          ids: [orderA],
          via: OrderConfirmationChannel.CALL
        })
      ]

      const responses = await Promise.all(writes)
      // The selection answers 200 and says that nothing was confirmed; every other write is a 404
      expect(responses.slice(0, -1).map(response => response.status)).toEqual(
        Array(writes.length - 1).fill(404)
      )
      expect((responses.at(-1)?.body as { succeeded: string[] }).succeeded).toEqual([])
      const after = await owner.order.findUniqueOrThrow({ where: { id: orderA } })
      expect(after.status).toBe(OrderStatus.PENDING_CONFIRMATION)
      expect(after.confirmedByPluginId).toBeNull()
      expect(after.cancelledByPluginId).toBeNull()
      expect(await owner.orderMessageDispatch.count({ where: { orderId: orderA } })).toBe(0)
    })
  })

  // What a plugin key reads and writes of the catalog, the stock and the warehouses (Step 5.6, E4a): the key of store B reaches the
  // products and the stock of store B and the warehouses of organization B, and a product of store A, a warehouse of organization A
  // and the stock of store A are rows that do not exist for it, by id, by list and by write.
  describe('the catalog, the stock and the warehouses with the key of a plugin', () => {
    const pluginId = `${prefix}-catalog`
    let keyOfB = ''
    let productA = ''
    let productB = ''

    beforeAll(async () => {
      ;({ key: keyOfB } = await createPluginKey(owner, {
        storeId: ctx.storeB.id,
        pluginId,
        scopes: [
          PluginScopes.PRODUCTS_READ,
          PluginScopes.PRODUCTS_WRITE,
          PluginScopes.PRODUCTS_DELETE,
          PluginScopes.INVENTORY_READ,
          PluginScopes.WAREHOUSES_READ
        ]
      }))
      productA = (await createProduct(owner, { storeId: ctx.storeA.id })).id
      productB = (await createProduct(owner, { storeId: ctx.storeB.id })).id
      await createInventoryLevel(owner, {
        storeId: ctx.storeA.id,
        productId: productA,
        warehouseId: ctx.warehouseA.id,
        onHand: 3
      })
    })
    afterAll(async () => {
      await owner.pluginInstallation.deleteMany({ where: { pluginId } })
      await owner.plugin.deleteMany({ where: { id: pluginId } })
    })

    const asB = (method: 'get' | 'patch' | 'delete', path: string) =>
      supertest(app.getHttpServer() as Parameters<typeof supertest>[0])
        [method](`${API_PREFIX}${path}`)
        .set('authorization', `Bearer ${keyOfB}`)

    it('works in its own store and organization, so that the 404 of the others means "foreign"', async () => {
      expect((await asB('get', PluginApiRoutes.products.byId(productB))).status).toBe(200)
      expect((await asB('get', PluginApiRoutes.products.inventory(productB))).status).toBe(200)
      expect((await asB('get', PluginApiRoutes.inventory.levels)).status).toBe(200)
      expect((await asB('get', PluginApiRoutes.warehouses.byId(ctx.warehouseB.id))).status).toBe(
        200
      )
    })

    it('does not read, change or delete a product of another store, and does not list it', async () => {
      const reads = [
        await asB('get', PluginApiRoutes.products.byId(productA)),
        await asB('get', PluginApiRoutes.products.images(productA)),
        await asB('get', PluginApiRoutes.products.inventory(productA))
      ]
      const changed = await asB('patch', PluginApiRoutes.products.byId(productA)).send({
        name: 'taken'
      })
      const removed = await asB('delete', PluginApiRoutes.products.byId(productA))
      const list = await asB('get', PluginApiRoutes.products.list)

      for (const response of [...reads, changed, removed]) expect(response.status).toBe(404)
      expect(JSON.stringify(list.body)).not.toContain(productA)
      expect((await owner.product.findUniqueOrThrow({ where: { id: productA } })).name).not.toBe(
        'taken'
      )
    })

    it('does not list the stock of another store nor read a warehouse of another organization', async () => {
      const levels = await asB('get', PluginApiRoutes.inventory.levels)
      const movements = await asB('get', PluginApiRoutes.inventory.movements)
      const foreign = await asB('get', PluginApiRoutes.warehouses.byId(ctx.warehouseA.id))
      const list = await asB('get', PluginApiRoutes.warehouses.list)

      expect(JSON.stringify(levels.body)).not.toContain(productA)
      expect(JSON.stringify(movements.body)).not.toContain(productA)
      expect(foreign.status).toBe(404)
      expect(JSON.stringify(list.body)).not.toContain(ctx.warehouseA.id)
    })
  })

  // The writes of stock and of the tag catalog with the key of a plugin (Step 5.6, E4a-2): the key of store B adjusts stock and
  // writes tags, and nothing of store A or of organization A moves or changes.
  describe('the adjustment of stock and the tag catalog with the key of a plugin', () => {
    const pluginId = `${prefix}-stock-tags`
    let keyOfB = ''
    let productA = ''
    let productB = ''
    let tagA = ''
    let tagB = ''

    beforeAll(async () => {
      ;({ key: keyOfB } = await createPluginKey(owner, {
        storeId: ctx.storeB.id,
        pluginId,
        scopes: [
          PluginScopes.INVENTORY_READ,
          PluginScopes.INVENTORY_WRITE,
          PluginScopes.TAGS_READ,
          PluginScopes.TAGS_WRITE
        ]
      }))
      productA = (await createProduct(owner, { storeId: ctx.storeA.id, trackInventory: true })).id
      productB = (await createProduct(owner, { storeId: ctx.storeB.id, trackInventory: true })).id
      tagA = (await createTag(owner, { storeId: ctx.storeA.id })).id
      tagB = (await createTag(owner, { storeId: ctx.storeB.id })).id
    })
    afterAll(async () => {
      await owner.pluginInstallation.deleteMany({ where: { pluginId } })
      await owner.plugin.deleteMany({ where: { id: pluginId } })
    })

    const asB = (method: 'get' | 'post' | 'patch' | 'delete', path: string) =>
      supertest(app.getHttpServer() as Parameters<typeof supertest>[0])
        [method](`${API_PREFIX}${path}`)
        .set('authorization', `Bearer ${keyOfB}`)

    const adjustment = (productId: string, warehouseId: string) => ({
      productId,
      warehouseId,
      type: InventoryMovementType.RECEIPT,
      quantity: 4,
      reason: InventoryAdjustmentReason.OPENING_STOCK,
      idempotencyKey: randomUUID()
    })

    it('adjusts the stock of its own store, as the plugin and never as a person', async () => {
      const response = await asB('post', PluginApiRoutes.inventory.adjustments).send(
        adjustment(productB, ctx.warehouseB.id)
      )

      expect(response.status).toBe(201)
      const movement = await owner.inventoryMovement.findFirstOrThrow({
        where: { productId: productB }
      })
      expect(movement.storeId).toBe(ctx.storeB.id)
      expect(movement.createdBy).toBeNull()
      expect(movement.createdByPluginId).toBe(pluginId)
    })

    it('does not adjust the stock of a product of another store, nor into a warehouse of another organization', async () => {
      const foreignProduct = await asB('post', PluginApiRoutes.inventory.adjustments).send(
        adjustment(productA, ctx.warehouseB.id)
      )
      const foreignWarehouse = await asB('post', PluginApiRoutes.inventory.adjustments).send(
        adjustment(productB, ctx.warehouseA.id)
      )

      expect(foreignProduct.status).toBe(404)
      expect(foreignWarehouse.status).toBe(404)
      expect(await owner.inventoryMovement.count({ where: { productId: productA } })).toBe(0)
      expect(
        await owner.inventoryMovement.count({
          where: { productId: productB, warehouseId: ctx.warehouseA.id }
        })
      ).toBe(0)
    })

    it('lists only the tags of its own store and does not find, change or delete one of another', async () => {
      const list = await asB('get', PluginApiRoutes.settings.tags)
      const read = await asB('get', PluginApiRoutes.settings.tagById(tagA))
      const changed = await asB('patch', PluginApiRoutes.settings.tagById(tagA)).send({
        name: 'taken'
      })
      const removed = await asB('delete', PluginApiRoutes.settings.tagById(tagA))

      expect(JSON.stringify(list.body)).toContain(tagB)
      expect(JSON.stringify(list.body)).not.toContain(tagA)
      for (const response of [read, changed, removed]) expect(response.status).toBe(404)
      expect((await owner.tag.findUniqueOrThrow({ where: { id: tagA } })).name).not.toBe('taken')
    })
  })

  // What a plugin key reads of the transfers and the counts (Step 5.6, E4b): both belong to the ORGANIZATION and their lines to
  // the stores, and a key is bound to ONE store. The key of store A reads the lines of store A and the transfers and counts that have
  // one; the key of its sibling store A2 sees the lines of A2 only and gets a 404 for what has no line of A2; the key of
  // organization B reaches nothing of organization A; and no write is there.
  describe('the transfers and the counts with the key of a plugin', () => {
    const pluginId = `${prefix}-transfers-counts`
    const scopes = [PluginScopes.TRANSFERS_READ, PluginScopes.COUNTS_READ]
    let keyOfA = ''
    let keyOfA2 = ''
    let keyOfB = ''
    let readsNothing = ''
    let transferA = ''
    let transferShared = ''
    let transferEmpty = ''
    let transferOfB = ''
    let countA = ''
    let countOnlyA = ''
    let countOnlyA2 = ''

    beforeAll(async () => {
      ;({ key: keyOfA } = await createPluginKey(owner, {
        storeId: ctx.storeA.id,
        pluginId: `${pluginId}-a`,
        scopes
      }))
      ;({ key: keyOfA2 } = await createPluginKey(owner, {
        storeId: ctx.storeA2.id,
        pluginId: `${pluginId}-a2`,
        scopes
      }))
      ;({ key: keyOfB } = await createPluginKey(owner, {
        storeId: ctx.storeB.id,
        pluginId: `${pluginId}-b`,
        scopes
      }))
      ;({ key: readsNothing } = await createPluginKey(owner, {
        storeId: ctx.storeA.id,
        pluginId: `${pluginId}-none`,
        scopes: [PluginScopes.INVENTORY_READ]
      }))
      transferA = (
        await createTransfer(owner, { organizationId: ctx.orgA.id, storeId: ctx.storeA.id })
      ).id
      transferEmpty = (await createTransfer(owner, { organizationId: ctx.orgA.id })).id
      transferOfB = (
        await createTransfer(owner, { organizationId: ctx.orgB.id, storeId: ctx.storeB.id })
      ).id
      // One transfer with a line of each sibling store
      const shared = await createTransfer(owner, {
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id
      })
      const sibling = await createProduct(owner, { storeId: ctx.storeA2.id })
      await owner.stockTransferLine.create({
        data: { transferId: shared.id, storeId: ctx.storeA2.id, productId: sibling.id, quantity: 2 }
      })
      transferShared = shared.id
      // A count of the warehouse with a line of store A, and one limited to store A2
      countA = (await createCountOf(owner, ctx.storeA.id, CountStatus.COUNTING)).countId
      // A count of the whole warehouse with a line of store A only
      countOnlyA = (await createCountOf(owner, ctx.storeA.id, CountStatus.COUNTING)).countId
      // countA holds a line of the sibling store too: neither key may count the line of the other
      const siblingProduct = await createProduct(owner, { storeId: ctx.storeA2.id })
      await owner.stockCountLine.create({
        data: {
          countId: countA,
          storeId: ctx.storeA2.id,
          productId: siblingProduct.id,
          expectedQuantity: 9
        }
      })
      countOnlyA2 = (await createCountOf(owner, ctx.storeA2.id, CountStatus.COUNTING, true)).countId
    })
    afterAll(async () => {
      await owner.pluginInstallation.deleteMany({ where: { pluginId: { startsWith: pluginId } } })
      await owner.plugin.deleteMany({ where: { id: { startsWith: pluginId } } })
    })

    const as = (key: string, path: string) =>
      supertest(app.getHttpServer() as Parameters<typeof supertest>[0])
        .get(`${API_PREFIX}${path}`)
        .set('authorization', `Bearer ${key}`)
    const storesOfLines = (response: { body: unknown }): string[] =>
      (response.body as { lines: { storeId: string }[] }).lines.map(line => line.storeId)

    it('works in its own store and organization, so that the 404 of the others means "foreign"', async () => {
      expect((await as(keyOfA, PluginApiRoutes.transfers.byId(transferA))).status).toBe(200)
      expect((await as(keyOfA, PluginApiRoutes.counts.byId(countA))).status).toBe(200)
      expect((await as(keyOfB, PluginApiRoutes.transfers.byId(transferOfB))).status).toBe(200)
    })

    it('does not read a transfer or a count of another organization, by id or by list', async () => {
      const byId = await as(keyOfB, PluginApiRoutes.transfers.byId(transferA))
      const countById = await as(keyOfB, PluginApiRoutes.counts.byId(countA))
      const transfers = await as(keyOfB, PluginApiRoutes.transfers.list)
      const counts = await as(keyOfB, PluginApiRoutes.counts.list)

      expect(byId.status).toBe(404)
      expect(countById.status).toBe(404)
      expect(JSON.stringify(transfers.body)).not.toContain(transferA)
      expect(JSON.stringify(counts.body)).not.toContain(countA)
    })

    it('shows each key of two sibling stores the lines of its own store only', async () => {
      const fromA = await as(keyOfA, PluginApiRoutes.transfers.byId(transferShared))
      const fromA2 = await as(keyOfA2, PluginApiRoutes.transfers.byId(transferShared))

      expect(storesOfLines(fromA)).toEqual([ctx.storeA.id])
      expect(storesOfLines(fromA2)).toEqual([ctx.storeA2.id])
    })

    it('counts and lists only the lines of the store of the key in a transfer or a count that spans two', async () => {
      const count = await as(keyOfA, PluginApiRoutes.counts.byId(countA))
      const count2 = await as(keyOfA2, PluginApiRoutes.counts.byId(countA))
      const counts = await as(keyOfA, PluginApiRoutes.counts.list)
      const transfers = await as(keyOfA, PluginApiRoutes.transfers.list)
      const transfers2 = await as(keyOfA2, PluginApiRoutes.transfers.list)
      const linesOf = (response: { body: unknown }, id: string): number | undefined =>
        (response.body as { data: { id: string; lineCount: number }[] }).data.find(
          row => row.id === id
        )?.lineCount

      const totals = (response: { body: unknown }): { lines: number; stores: string[] } => ({
        lines: (response.body as { totals: { lines: number } }).totals.lines,
        stores: storesOfLines(response)
      })
      expect(totals(count)).toEqual({ lines: 1, stores: [ctx.storeA.id] })
      expect(totals(count2)).toEqual({ lines: 1, stores: [ctx.storeA2.id] })
      expect(JSON.stringify(counts.body)).toContain(countA)
      expect(linesOf(transfers, transferShared)).toBe(1)
      expect(linesOf(transfers2, transferShared)).toBe(1)
    })

    it('does not show a sibling store a transfer or a count that has no line of its own', async () => {
      const transfer = await as(keyOfA2, PluginApiRoutes.transfers.byId(transferA))
      const transfers = await as(keyOfA2, PluginApiRoutes.transfers.list)
      const count = await as(keyOfA, PluginApiRoutes.counts.byId(countOnlyA2))
      const counts = await as(keyOfA, PluginApiRoutes.counts.list)
      const countOfA = await as(keyOfA2, PluginApiRoutes.counts.byId(countOnlyA))

      expect(transfer.status).toBe(404)
      expect(countOfA.status).toBe(404)
      expect(JSON.stringify(transfers.body)).not.toContain(transferA)
      expect(count.status).toBe(404)
      expect(JSON.stringify(counts.body)).not.toContain(countOnlyA2)
    })

    it('does not show a transfer that has no line yet, which belongs to no store', async () => {
      const byId = await as(keyOfA, PluginApiRoutes.transfers.byId(transferEmpty))
      const list = await as(keyOfA, PluginApiRoutes.transfers.list)

      expect(byId.status).toBe(404)
      expect(JSON.stringify(list.body)).not.toContain(transferEmpty)
    })

    it('does not answer the id of the people who made, sent or approved them', async () => {
      const bodies = [
        await as(keyOfA, PluginApiRoutes.transfers.byId(transferA)),
        await as(keyOfA, PluginApiRoutes.transfers.list),
        await as(keyOfA, PluginApiRoutes.counts.byId(countA)),
        await as(keyOfA, PluginApiRoutes.counts.list)
      ]

      for (const response of bodies) {
        expect(response.status).toBe(200)
        expect(JSON.stringify(response.body)).not.toMatch(/createdBy|dispatchedBy|appliedBy/)
      }
    })

    it('needs the scope of the route', async () => {
      const denied = await as(readsNothing, PluginApiRoutes.transfers.list)
      const deniedCounts = await as(readsNothing, PluginApiRoutes.counts.list)

      expect([denied.status, deniedCounts.status]).toEqual([403, 403])
    })
  })

  // What a plugin key WRITES of the transfers and the counts (Step 5.6, E4b-2). A key is bound to ONE store, so it writes only a
  // transfer whose every line is of its store (409 when a sibling store's line is there) and a count limited to its store (403 for
  // a count of the whole warehouse); a transfer or a count of another store or organization does not exist for it (404). The
  // scope of the route decides: a key that only reads writes nothing, and a key that writes without reading cannot reach the routes.
  describe('the writes of the transfers and the counts with the key of a plugin', () => {
    const pluginId = `${prefix}-transfers-counts-write`
    const everything = [
      PluginScopes.TRANSFERS_READ,
      PluginScopes.TRANSFERS_WRITE,
      PluginScopes.TRANSFERS_RECEIVE,
      PluginScopes.COUNTS_READ,
      PluginScopes.COUNTS_WRITE,
      PluginScopes.COUNTS_APPLY
    ]
    let keyOfA = ''
    let keyOfA2 = ''
    let keyOfB = ''
    let readOnly = ''
    let writeWithoutRead = ''
    let transferA = ''
    let transferShared = ''
    let transferOfB = ''
    let countLimitedA = ''
    let countWholeWarehouse = ''
    let countLimitedA2 = ''

    beforeAll(async () => {
      ;({ key: keyOfA } = await createPluginKey(owner, {
        storeId: ctx.storeA.id,
        pluginId: `${pluginId}-a`,
        scopes: everything
      }))
      ;({ key: keyOfA2 } = await createPluginKey(owner, {
        storeId: ctx.storeA2.id,
        pluginId: `${pluginId}-a2`,
        scopes: everything
      }))
      ;({ key: keyOfB } = await createPluginKey(owner, {
        storeId: ctx.storeB.id,
        pluginId: `${pluginId}-b`,
        scopes: everything
      }))
      ;({ key: readOnly } = await createPluginKey(owner, {
        storeId: ctx.storeA.id,
        pluginId: `${pluginId}-read`,
        scopes: [PluginScopes.TRANSFERS_READ, PluginScopes.COUNTS_READ]
      }))
      ;({ key: writeWithoutRead } = await createPluginKey(owner, {
        storeId: ctx.storeA.id,
        pluginId: `${pluginId}-write`,
        scopes: [
          PluginScopes.TRANSFERS_WRITE,
          PluginScopes.TRANSFERS_RECEIVE,
          PluginScopes.COUNTS_WRITE,
          PluginScopes.COUNTS_APPLY
        ]
      }))
      transferA = (
        await createTransfer(owner, { organizationId: ctx.orgA.id, storeId: ctx.storeA.id })
      ).id
      transferOfB = (
        await createTransfer(owner, { organizationId: ctx.orgB.id, storeId: ctx.storeB.id })
      ).id
      // A transfer with a line of each sibling store: the key of either may read it and neither may write it
      const shared = await createTransfer(owner, {
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id
      })
      const sibling = await createProduct(owner, { storeId: ctx.storeA2.id })
      await owner.stockTransferLine.create({
        data: { transferId: shared.id, storeId: ctx.storeA2.id, productId: sibling.id, quantity: 2 }
      })
      transferShared = shared.id
      countLimitedA = (await createCountOf(owner, ctx.storeA.id, CountStatus.COUNTING, true))
        .countId
      countWholeWarehouse = (await createCountOf(owner, ctx.storeA.id, CountStatus.COUNTING))
        .countId
      countLimitedA2 = (await createCountOf(owner, ctx.storeA2.id, CountStatus.COUNTING, true))
        .countId
    })
    afterAll(async () => {
      await owner.pluginInstallation.deleteMany({ where: { pluginId: { startsWith: pluginId } } })
      await owner.plugin.deleteMany({ where: { id: { startsWith: pluginId } } })
    })

    const send = (key: string, method: 'post' | 'patch', path: string, body: object = {}) =>
      supertest(app.getHttpServer() as Parameters<typeof supertest>[0])
        [method](`${API_PREFIX}${path}`)
        .set('authorization', `Bearer ${key}`)
        .send(body)
    const transferStatus = async (id: string) =>
      (await owner.stockTransfer.findUniqueOrThrow({ where: { id } })).status
    const countStatus = async (id: string) =>
      (await owner.stockCount.findUniqueOrThrow({ where: { id } })).status
    const uuid = '00000000-0000-4000-8000-000000000001'
    const codeOf = (response: { body: unknown }): string =>
      (response.body as { error: { code: string } }).error.code

    const transferWrites = (id: string): [string, 'post' | 'patch', string, object][] => [
      [
        'create',
        'post',
        PluginApiRoutes.transfers.create,
        { fromWarehouseId: uuid, toWarehouseId: uuid }
      ],
      ['update', 'patch', PluginApiRoutes.transfers.byId(id), { note: 'x' }],
      ['dispatch', 'post', PluginApiRoutes.transfers.dispatch(id), {}],
      [
        'receive',
        'post',
        PluginApiRoutes.transfers.receive(id),
        { receiptKey: uuid, lines: [{ lineId: uuid, quantity: 1 }] }
      ],
      ['close', 'post', PluginApiRoutes.transfers.close(id), { lines: [] }],
      ['cancel', 'post', PluginApiRoutes.transfers.cancel(id), {}]
    ]
    const countWrites = (id: string): [string, 'post' | 'patch', string, object][] => [
      ['create', 'post', PluginApiRoutes.counts.create, { warehouseId: uuid }],
      ['start', 'post', PluginApiRoutes.counts.start(id), {}],
      [
        'lines',
        'patch',
        PluginApiRoutes.counts.lines(id),
        { lines: [{ lineId: uuid, countedQuantity: 1 }] }
      ],
      ['submit', 'post', PluginApiRoutes.counts.submit(id), {}],
      ['reopen', 'post', PluginApiRoutes.counts.reopen(id), {}],
      ['apply', 'post', PluginApiRoutes.counts.apply(id), {}],
      ['cancel', 'post', PluginApiRoutes.counts.cancel(id), {}]
    ]

    it('refuses every write to a key that only reads, and to a key that writes without reading (403)', async () => {
      const routes = [...transferWrites(transferA), ...countWrites(countLimitedA)]
      for (const key of [readOnly, writeWithoutRead]) {
        for (const [name, method, path, body] of routes) {
          const response = await send(key, method, path, body)
          expect([name, response.status]).toEqual([name, 403])
        }
      }
      expect(await transferStatus(transferA)).toBe(TransferStatus.DRAFT)
      expect(await countStatus(countLimitedA)).toBe(CountStatus.COUNTING)
    })

    it('does not let a key write what it needs the other scope for: receiving is not sending, applying is not counting', async () => {
      const sendsOnly = await createPluginKey(owner, {
        storeId: ctx.storeA.id,
        pluginId: `${pluginId}-sends`,
        scopes: [
          PluginScopes.TRANSFERS_READ,
          PluginScopes.TRANSFERS_WRITE,
          PluginScopes.COUNTS_READ,
          PluginScopes.COUNTS_WRITE
        ]
      })
      const receive = await send(
        sendsOnly.key,
        'post',
        PluginApiRoutes.transfers.receive(transferA),
        {
          receiptKey: uuid,
          lines: [{ lineId: uuid, quantity: 1 }]
        }
      )
      const close = await send(sendsOnly.key, 'post', PluginApiRoutes.transfers.close(transferA), {
        lines: []
      })
      const apply = await send(sendsOnly.key, 'post', PluginApiRoutes.counts.apply(countLimitedA))

      expect([receive.status, close.status, apply.status]).toEqual([403, 403, 403])
      expect(await countStatus(countLimitedA)).toBe(CountStatus.COUNTING)
    })

    it('does not write a transfer or a count of another organization (404), and changes nothing', async () => {
      for (const [name, method, path, body] of transferWrites(transferA).slice(1)) {
        const response = await send(keyOfB, method, path, body)
        expect([name, response.status]).toEqual([name, 404])
      }
      for (const [name, method, path, body] of countWrites(countLimitedA).slice(1)) {
        const response = await send(keyOfB, method, path, body)
        expect([name, response.status]).toEqual([name, 404])
      }
      // A real product of its own store with the warehouses of the other organization: only the warehouses are foreign
      const ownProduct = await createProduct(owner, { storeId: ctx.storeB.id })
      const warehouses = await owner.stockTransfer.findUniqueOrThrow({ where: { id: transferA } })
      const created = await send(keyOfB, 'post', PluginApiRoutes.transfers.create, {
        fromWarehouseId: warehouses.fromWarehouseId,
        toWarehouseId: warehouses.toWarehouseId,
        lines: [{ productId: ownProduct.id, quantity: 1 }]
      })
      expect(created.status).toBe(404)
      expect(await transferStatus(transferA)).toBe(TransferStatus.DRAFT)
      expect(await countStatus(countLimitedA)).toBe(CountStatus.COUNTING)
      expect(await transferStatus(transferOfB)).toBe(TransferStatus.DRAFT)
    })

    it('does not write a transfer or a count that has nothing of the sibling store of the key (404)', async () => {
      for (const [name, method, path, body] of transferWrites(transferA).slice(1)) {
        const response = await send(keyOfA2, method, path, body)
        expect([name, response.status]).toEqual([name, 404])
      }
      for (const [name, method, path, body] of countWrites(countLimitedA).slice(1)) {
        const response = await send(keyOfA2, method, path, body)
        expect([name, response.status]).toEqual([name, 404])
      }
      expect(await transferStatus(transferA)).toBe(TransferStatus.DRAFT)
      expect(await countStatus(countLimitedA)).toBe(CountStatus.COUNTING)
    })

    it('reads a transfer that spans two stores but writes none of it: the stock of the sibling store is not its to move (409)', async () => {
      const before = await owner.stockTransferLine.count({ where: { transferId: transferShared } })
      for (const key of [keyOfA, keyOfA2]) {
        for (const [name, method, path, body] of transferWrites(transferShared).slice(1)) {
          const response = await send(key, method, path, body)
          // The code too: a draft is refused by receive and close for its state, so the status alone proves nothing
          expect([name, response.status, codeOf(response)]).toEqual([
            name,
            409,
            ErrorCodes.INVENTORY_TRANSFER_LINES_OUT_OF_REACH
          ])
        }
      }
      expect(await transferStatus(transferShared)).toBe(TransferStatus.DRAFT)
      expect(await owner.stockTransferLine.count({ where: { transferId: transferShared } })).toBe(
        before
      )
    })

    it('reads a count of the whole warehouse but writes none of it (403), and opens its own limited to its store', async () => {
      for (const [name, method, path, body] of countWrites(countWholeWarehouse).slice(1)) {
        const response = await send(keyOfA, method, path, body)
        expect([name, response.status]).toEqual([name, 403])
        // The sibling store has no line in it: for that key the count does not exist
        const sibling = await send(keyOfA2, method, path, body)
        expect([name, sibling.status]).toEqual([name, 404])
      }
      // A count a plugin opens is the store of the key's, whatever the body says, and a store of another key is not its to name:
      // the warehouse is real and linked to both stores, so only the store decides
      const shared = await createWarehouse(owner, { organizationId: ctx.orgA.id })
      for (const storeId of [ctx.storeA.id, ctx.storeA2.id]) {
        await linkWarehouse(owner, { organizationId: ctx.orgA.id, storeId, warehouseId: shared.id })
      }
      const foreignStore = await send(keyOfA2, 'post', PluginApiRoutes.counts.create, {
        warehouseId: shared.id,
        storeId: ctx.storeA.id
      })
      expect(foreignStore.status).toBe(404)
      const own = await send(keyOfA2, 'post', PluginApiRoutes.counts.create, {
        warehouseId: shared.id
      })
      expect(own.status).toBe(201)
      expect((own.body as { storeId: string }).storeId).toBe(ctx.storeA2.id)
      expect(await countStatus(countWholeWarehouse)).toBe(CountStatus.COUNTING)
      expect(await countStatus(countLimitedA2)).toBe(CountStatus.COUNTING)
    })

    it('does not open a count of a warehouse the store of the key keeps no stock in, nor a transfer of a product of a sibling store', async () => {
      const unlinked = await createWarehouse(owner, { organizationId: ctx.orgA.id })
      const sibling = await createProduct(owner, { storeId: ctx.storeA2.id })
      const count = await send(keyOfA, 'post', PluginApiRoutes.counts.create, {
        warehouseId: unlinked.id
      })
      const transfer = await send(keyOfA, 'post', PluginApiRoutes.transfers.create, {
        fromWarehouseId: ctx.warehouseA.id,
        toWarehouseId: ctx.warehouseASecond.id,
        lines: [{ productId: sibling.id, quantity: 1 }]
      })
      const empty = await send(keyOfA, 'post', PluginApiRoutes.transfers.create, {
        fromWarehouseId: ctx.warehouseA.id,
        toWarehouseId: ctx.warehouseASecond.id
      })

      expect([count.status, transfer.status, empty.status]).toEqual([404, 404, 400])
    })
  })

  // The write-off of the difference of a guide (Step 4B.6b-2, E7) is a store's action on a store's guide that moves money in the books of
  // its organization: the admin of its sibling store and the admin of another organization reach no guide of it (a 404, as if it did not
  // exist), and the guide, its status and the books stay as they were; the entry of the books is read by organization, so another
  // organization's posting job finds nothing.
  describe('the write-off of the difference of a guide', () => {
    it('is not reachable from the sibling store or from another organization, and nothing changes', async () => {
      const guide = await createShipment(owner, {
        storeId: ctx.storeA.id,
        status: ShipmentStatus.DELIVERED,
        codAmountCents: 2515,
        codStatus: CodStatus.PENDING_REMITTANCE
      })
      const author = await owner.membership.findFirstOrThrow({
        where: { storeId: ctx.storeA.id },
        select: { userId: true }
      })
      const remittance = await owner.codRemittance.create({
        data: {
          storeId: ctx.storeA.id,
          connectionId: guide.connectionId,
          status: RemittanceStatus.CONFIRMED,
          createdBy: author.userId,
          confirmedAt: new Date(),
          confirmedBy: author.userId
        },
        select: { id: true }
      })
      await owner.shipment.update({
        where: { id: guide.id },
        data: { codStatus: CodStatus.DISCREPANCY, codRemittanceId: remittance.id }
      })
      for (const [user, store] of [
        [ctx.adminA2, ctx.storeA2],
        [ctx.adminB, ctx.storeB]
      ] as const) {
        const attempt = await api(app, user, store).post(ApiRoutes.remittances.writeOff(guide.id))
        expect(attempt.status).toBe(404)
      }
      expect((await owner.shipment.findUniqueOrThrow({ where: { id: guide.id } })).codStatus).toBe(
        CodStatus.DISCREPANCY
      )
      expect(await owner.journalEntry.count({ where: { sourceId: guide.id } })).toBe(0)
    })
  })

  // What a plugin key reads of the returns, the reception batches and the remittances (Step 5.6, E6): all of them belong to ONE store
  // and a key is bound to one store. The key of store A reads what store A holds; the key of its sibling store A2 and the key of
  // organization B reach nothing of it, by id or by list; no answer carries the id of a person or the file a remittance came from;
  // and no route that writes is there.
  describe('the returns and the remittances with the key of a plugin', () => {
    const pluginId = `${prefix}-returns-remittances`
    const scopes = [PluginScopes.RETURNS_READ, PluginScopes.REMITTANCES_READ]
    let keyOfA = ''
    let keyOfA2 = ''
    let keyOfB = ''
    let readsNothing = ''
    let returnA = ''
    let batchA = ''
    let remittanceA = ''
    let profileA = ''
    let authorOfA = ''

    beforeAll(async () => {
      for (const [slot, storeId] of [
        ['a', ctx.storeA.id],
        ['a2', ctx.storeA2.id],
        ['b', ctx.storeB.id]
      ] as const) {
        const { key } = await createPluginKey(owner, {
          storeId,
          pluginId: `${pluginId}-${slot}`,
          scopes
        })
        if (slot === 'a') keyOfA = key
        else if (slot === 'a2') keyOfA2 = key
        else keyOfB = key
      }
      ;({ key: readsNothing } = await createPluginKey(owner, {
        storeId: ctx.storeA.id,
        pluginId: `${pluginId}-none`,
        scopes: [PluginScopes.ORDERS_READ]
      }))
      authorOfA = await adminOf(owner, ctx.storeA.id)
      returnA = (await createReturn(owner, { storeId: ctx.storeA.id })).id
      batchA = (
        await owner.returnReceptionBatch.create({
          data: { storeId: ctx.storeA.id, createdBy: authorOfA },
          select: { id: true }
        })
      ).id
      const connection = await createCarrierConnection(owner, { storeId: ctx.storeA.id })
      remittanceA = (
        await createRemittance(owner, {
          storeId: ctx.storeA.id,
          connectionId: connection.id,
          withLine: true
        })
      ).id
      profileA = (
        await createRemittanceImportProfile(owner, {
          storeId: ctx.storeA.id,
          connectionId: connection.id
        })
      ).id
    })
    afterAll(async () => {
      await owner.pluginInstallation.deleteMany({ where: { pluginId: { startsWith: pluginId } } })
      await owner.plugin.deleteMany({ where: { id: { startsWith: pluginId } } })
    })

    const server = () => supertest(app.getHttpServer() as Parameters<typeof supertest>[0])
    const as = (key: string, path: string) =>
      server().get(`${API_PREFIX}${path}`).set('authorization', `Bearer ${key}`)
    const reads = (): string[] => [
      PluginApiRoutes.returns.byId(returnA),
      PluginApiRoutes.returns.list,
      PluginApiRoutes.returns.reception.batchById(batchA),
      PluginApiRoutes.returns.reception.batches,
      PluginApiRoutes.remittances.byId(remittanceA),
      PluginApiRoutes.remittances.list,
      PluginApiRoutes.remittances.pending,
      PluginApiRoutes.remittances.importProfiles
    ]

    it('reads what its own store holds', async () => {
      for (const path of reads()) expect((await as(keyOfA, path)).status).toBe(200)
      expect(JSON.stringify((await as(keyOfA, PluginApiRoutes.returns.list)).body)).toContain(
        returnA
      )
      expect(JSON.stringify((await as(keyOfA, PluginApiRoutes.remittances.list)).body)).toContain(
        remittanceA
      )
      expect(
        JSON.stringify((await as(keyOfA, PluginApiRoutes.remittances.importProfiles)).body)
      ).toContain(profileA)
    })

    it.each([
      ['a sibling store', () => keyOfA2],
      ['another organization', () => keyOfB]
    ])('does not read what %s holds, by id or by list', async (_name, key) => {
      expect((await as(key(), PluginApiRoutes.returns.byId(returnA))).status).toBe(404)
      expect((await as(key(), PluginApiRoutes.returns.reception.batchById(batchA))).status).toBe(
        404
      )
      expect((await as(key(), PluginApiRoutes.remittances.byId(remittanceA))).status).toBe(404)
      for (const [path, id] of [
        [PluginApiRoutes.returns.list, returnA],
        [PluginApiRoutes.returns.reception.batches, batchA],
        [PluginApiRoutes.remittances.list, remittanceA],
        [PluginApiRoutes.remittances.importProfiles, profileA]
      ] as const) {
        const response = await as(key(), path)
        expect(response.status).toBe(200)
        expect(JSON.stringify(response.body)).not.toContain(id)
      }
    })

    it('does not answer the id of a person, nor the file a remittance came from', async () => {
      for (const path of reads()) {
        const response = await as(keyOfA, path)
        const text = JSON.stringify(response.body)
        expect(text).not.toMatch(
          /createdBy|confirmedBy|voidedBy|sourceMediaId|flagReason|customerIsCaution/
        )
        expect(text).not.toContain(authorOfA)
      }
    })

    it('needs the scope of the route', async () => {
      for (const path of reads()) expect((await as(readsNothing, path)).status).toBe(403)
    })

    it('has no route that writes: a return, a batch or a remittance cannot be changed with a key', async () => {
      const attempts = [
        server().post(`${API_PREFIX}${PluginApiRoutes.returns.list}`).send({}),
        server()
          .post(`${API_PREFIX}${PluginApiRoutes.returns.byId(returnA)}/approve`)
          .send({}),
        server().post(`${API_PREFIX}${PluginApiRoutes.returns.reception.batches}`).send({}),
        server().post(`${API_PREFIX}${PluginApiRoutes.remittances.list}`).send({}),
        server()
          .post(`${API_PREFIX}${PluginApiRoutes.remittances.byId(remittanceA)}/confirm`)
          .send({}),
        server().delete(`${API_PREFIX}${PluginApiRoutes.remittances.byId(remittanceA)}`)
      ]
      for (const attempt of attempts) {
        expect((await attempt.set('authorization', `Bearer ${keyOfA}`)).status).toBe(404)
      }
      expect(
        (await owner.codRemittance.findUniqueOrThrow({ where: { id: remittanceA } })).status
      ).toBe(RemittanceStatus.DRAFT)
      expect((await owner.orderReturn.findUniqueOrThrow({ where: { id: returnA } })).status).toBe(
        'requested'
      )
    })
  })

  // What a plugin key reads of the shipping (Step 5.6, E5): the shipments, the carrier connections and the pickups of the store of the key,
  // read only. The key of store B reaches the rows of store B; a shipment, a connection or a pickup of store A is a row that does not
  // exist for it (by id, by list, by the places a carrier lists and by its statuses). What a carrier is paid and the secrets of a
  // connection are not in an answer, and no route that writes is there.
  describe('the shipments, the carriers and the pickups with the key of a plugin', () => {
    const pluginId = `${prefix}-shipping`
    let keyOfB = ''
    let keyWithoutCustomers = ''
    let keyWithoutShipments = ''
    let readsNothing = ''
    let shipmentA = ''
    let shipmentB = ''
    let connectionA = ''
    let connectionB = ''
    let pickupA = ''
    let pickupB = ''

    beforeAll(async () => {
      ;({ key: keyOfB } = await createPluginKey(owner, {
        storeId: ctx.storeB.id,
        pluginId: `${pluginId}-b`,
        scopes: [
          PluginScopes.SHIPMENTS_READ,
          PluginScopes.CARRIERS_READ,
          PluginScopes.PICKUPS_READ,
          PluginScopes.CUSTOMERS_READ
        ]
      }))
      ;({ key: keyWithoutCustomers } = await createPluginKey(owner, {
        storeId: ctx.storeB.id,
        pluginId: `${pluginId}-nocust`,
        scopes: [PluginScopes.PICKUPS_READ]
      }))
      ;({ key: keyWithoutShipments } = await createPluginKey(owner, {
        storeId: ctx.storeB.id,
        pluginId: `${pluginId}-noship`,
        scopes: [PluginScopes.PICKUPS_READ, PluginScopes.CUSTOMERS_READ]
      }))
      ;({ key: readsNothing } = await createPluginKey(owner, {
        storeId: ctx.storeB.id,
        pluginId: `${pluginId}-none`,
        scopes: [PluginScopes.PRODUCTS_READ]
      }))
      const builtA = await createShipment(owner, { storeId: ctx.storeA.id })
      const builtB = await createShipment(owner, {
        storeId: ctx.storeB.id,
        carrierCostCents: 777_001,
        codAmountCents: 5000,
        codExpectedCents: 777_002,
        codRemittedCents: 777_003
      })
      shipmentA = builtA.id
      shipmentB = builtB.id
      connectionA = builtA.connectionId
      connectionB = builtB.connectionId
      pickupA = (await createPickup(owner, { storeId: ctx.storeA.id })).id
      pickupB = (await createPickup(owner, { storeId: ctx.storeB.id })).id
    })
    afterAll(async () => {
      await owner.pluginInstallation.deleteMany({ where: { pluginId: { startsWith: pluginId } } })
      await owner.plugin.deleteMany({ where: { id: { startsWith: pluginId } } })
    })

    const as = (key: string, path: string) =>
      supertest(app.getHttpServer() as Parameters<typeof supertest>[0])
        .get(`${API_PREFIX}${path}`)
        .set('authorization', `Bearer ${key}`)

    it('works in its own store, so that the 404 of the others means "foreign"', async () => {
      const paths = [
        PluginApiRoutes.shipments.byId(shipmentB),
        PluginApiRoutes.carriers.byId(connectionB),
        PluginApiRoutes.carriers.registry,
        PluginApiRoutes.carriers.statusCatalog(connectionB),
        PluginApiRoutes.carriers.unmappedStatuses(connectionB),
        PluginApiRoutes.pickups.manifest(pickupB)
      ]

      for (const path of paths) expect([path, (await as(keyOfB, path)).status]).toEqual([path, 200])
      for (const path of [
        PluginApiRoutes.shipments.list,
        PluginApiRoutes.carriers.list,
        PluginApiRoutes.pickups.list
      ]) {
        expect([path, (await as(keyOfB, path)).status]).toEqual([path, 200])
      }
    })

    it('does not read a row of another store, by id or by the places and statuses of its connection', async () => {
      const foreign = [
        PluginApiRoutes.shipments.byId(shipmentA),
        PluginApiRoutes.carriers.byId(connectionA),
        PluginApiRoutes.carriers.statusCatalog(connectionA),
        PluginApiRoutes.carriers.unmappedStatuses(connectionA),
        PluginApiRoutes.pickups.manifest(pickupA)
      ]

      for (const path of foreign)
        expect([path, (await as(keyOfB, path)).status]).toEqual([path, 404])
    })

    it('does not list a row of another store, and cannot be told another store by the query', async () => {
      const shipments = await as(keyOfB, PluginApiRoutes.shipments.list)
      const carriers = await as(keyOfB, PluginApiRoutes.carriers.list)
      const pickups = await as(keyOfB, PluginApiRoutes.pickups.list)
      const byConnection = await as(
        keyOfB,
        `${PluginApiRoutes.shipments.list}?connectionId=${connectionA}`
      )

      expect(JSON.stringify(shipments.body)).not.toContain(shipmentA)
      expect(JSON.stringify(carriers.body)).not.toContain(connectionA)
      expect(JSON.stringify(pickups.body)).not.toContain(pickupA)
      expect(JSON.stringify(shipments.body)).toContain(shipmentB)
      expect(byConnection.status).toBe(200)
      expect((byConnection.body as { data: unknown[] }).data).toEqual([])
      expect(JSON.stringify(byConnection.body)).not.toContain(shipmentA)
    })

    it('does not answer the money of the carrier, the people, nor a secret of the connection', async () => {
      const bodies = [
        await as(keyOfB, PluginApiRoutes.shipments.byId(shipmentB)),
        await as(keyOfB, PluginApiRoutes.shipments.list),
        await as(keyOfB, PluginApiRoutes.carriers.byId(connectionB)),
        await as(keyOfB, PluginApiRoutes.carriers.list),
        await as(keyOfB, PluginApiRoutes.carriers.registry),
        await as(keyOfB, PluginApiRoutes.pickups.list),
        await as(keyOfB, PluginApiRoutes.pickups.manifest(pickupB)),
        await as(keyOfB, PluginApiRoutes.carriers.statusCatalog(connectionB)),
        await as(keyOfB, PluginApiRoutes.carriers.unmappedStatuses(connectionB))
      ]
      // The fixture holds what the assertions look for: a contact on the connection and money on the guide
      expect(
        (await owner.carrierConnection.findUniqueOrThrow({ where: { id: connectionB } })).contact
      ).toEqual({ phone: '70000000' })
      expect(
        (await owner.shipment.findUniqueOrThrow({ where: { id: shipmentB } })).carrierCostCents
      ).toBe(777_001)

      for (const response of bodies) {
        expect(response.status).toBe(200)
        const text = JSON.stringify(response.body)
        expect(text).not.toMatch(
          /carrierCostCents|codExpectedCents|codRemittedCents|codRemittanceId|createdBy|requestedBy/
        )
        expect(text).not.toMatch(
          /hasCredentials|hasWebhookSecret|webhookUrl|commissionBps|serviceRatesCents|connectFields|guidePrefix|sampleRawStatus|"contact"|70000000/
        )
        expect(text).not.toMatch(/77700[123]/)
      }
    })

    it('needs the scope of the route, and `customers:read` and `shipments:read` for the list of the courier', async () => {
      const noScope = await as(readsNothing, PluginApiRoutes.shipments.list)
      const noCarriers = await as(keyWithoutCustomers, PluginApiRoutes.carriers.list)
      const noCustomers = await as(keyWithoutCustomers, PluginApiRoutes.pickups.manifest(pickupB))

      const noShipments = await as(keyWithoutShipments, PluginApiRoutes.pickups.manifest(pickupB))
      const manifest = await as(keyOfB, PluginApiRoutes.pickups.manifest(pickupB))

      expect([noScope.status, noCarriers.status, noCustomers.status, noShipments.status]).toEqual([
        403, 403, 403, 403
      ])
      expect(manifest.headers['cache-control']).toMatch(/no-store/)
      expect((await as(keyWithoutCustomers, PluginApiRoutes.pickups.list)).status).toBe(200)
    })

    it('has no route that writes, and the rows are the same after trying', async () => {
      const server = () => supertest(app.getHttpServer() as Parameters<typeof supertest>[0])
      const attempts = [
        server().post(`${API_PREFIX}${PluginApiRoutes.shipments.list}`).send({}),
        server().post(`${API_PREFIX}${PluginApiRoutes.shipments.byId(shipmentB)}/cancel`),
        server()
          .patch(`${API_PREFIX}${PluginApiRoutes.carriers.byId(connectionB)}`)
          .send({}),
        server().post(`${API_PREFIX}${PluginApiRoutes.carriers.list}`).send({}),
        server().post(`${API_PREFIX}${PluginApiRoutes.pickups.list}`).send({})
      ]

      // The staff routes that really write are not reachable with the key of a plugin either: it is not a session
      attempts.push(
        server().post(`${API_PREFIX}${ApiRoutes.shipments.cancel(shipmentB)}`),
        server().post(`${API_PREFIX}${ApiRoutes.pickups.cancel(pickupB)}`)
      )
      const staff = await Promise.all(
        attempts
          .slice(-2)
          .map(attempt =>
            attempt.set('authorization', `Bearer ${keyOfB}`).set('x-store-id', ctx.storeB.id)
          )
      )
      for (const response of staff) expect([401, 403]).toContain(response.status)

      for (const attempt of attempts.slice(0, -2)) {
        expect((await attempt.set('authorization', `Bearer ${keyOfB}`)).status).toBe(404)
      }
      expect(
        (await owner.shipment.findUniqueOrThrow({ where: { id: shipmentB } })).cancelledAt
      ).toBeNull()
    })
  })

  // What a plugin key reads and makes of the exports centre, the files and the figures (Step 5.6, E7): the file of an export leaves the
  // platform with the data of the customers, so the owner of a row is the installation that asked (`plugin:<id>`), a person's exports are a
  // 404 to it and its own never reach a person's centre; a file or a customer of another store is a 404; no address is given unsigned.
  describe('the exports, the files and the figures with the key of a plugin', () => {
    const pluginId = `${prefix}-exports-media`
    const scopes = [
      PluginScopes.ANALYTICS_READ,
      PluginScopes.EXPORTS_READ,
      PluginScopes.EXPORTS_WRITE,
      PluginScopes.MEDIA_READ,
      PluginScopes.MEDIA_WRITE,
      PluginScopes.CUSTOMERS_READ,
      PluginScopes.CONVERSATIONS_READ
    ]
    let keyOfA = ''
    let keyOfB = ''
    let keyOfA2 = ''
    let readsExportsOnly = ''
    let readsNothing = ''
    let installationA = ''
    let installationOnlyRead = ''
    let ownExport = ''
    let ownExportOfAnotherInstallation = ''
    let exportOfAPerson = ''
    let exportOfB = ''
    let exportOfLostKind = ''
    let fileA = ''
    let fileB = ''

    const exportRow = async (
      storeId: string,
      requestedBy: string,
      type: string = ExportTypes.ANALYTICS
    ) =>
      (
        await owner.export.create({
          data: {
            storeId,
            requestedBy,
            type,
            format: ExportFormats.CSV,
            // Made, so that none of them counts as an export in progress of its installation
            status: ExportStatus.READY,
            expiresAt: new Date(Date.now() + 86_400_000)
          },
          select: { id: true }
        })
      ).id
    const fileOf = async (storeId: string) =>
      (
        await owner.media.create({
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
        })
      ).id
    const server = () => supertest(app.getHttpServer() as Parameters<typeof supertest>[0])
    const get = (key: string, path: string) =>
      server().get(`${API_PREFIX}${path}`).set('authorization', `Bearer ${key}`)
    const post = (key: string, path: string) =>
      server().post(`${API_PREFIX}${path}`).set('authorization', `Bearer ${key}`)
    const idsOf = (response: { body: unknown }): string[] =>
      (response.body as { data: { id: string }[] }).data.map(row => row.id)
    const analyticsQuery = {
      metrics: ReportMetrics[0] ?? '',
      from: '2026-01-01',
      to: '2026-01-08',
      format: 'csv'
    }

    beforeAll(async () => {
      ;({ key: keyOfA, installationId: installationA } = await createPluginKey(owner, {
        storeId: ctx.storeA.id,
        pluginId: `${pluginId}-a`,
        scopes
      }))
      ;({ key: keyOfA2 } = await createPluginKey(owner, {
        storeId: ctx.storeA.id,
        pluginId: `${pluginId}-a-other`,
        scopes
      }))
      ;({ key: keyOfB } = await createPluginKey(owner, {
        storeId: ctx.storeB.id,
        pluginId: `${pluginId}-b`,
        scopes
      }))
      ;({ key: readsExportsOnly, installationId: installationOnlyRead } = await createPluginKey(
        owner,
        {
          storeId: ctx.storeA.id,
          pluginId: `${pluginId}-read`,
          scopes: [PluginScopes.EXPORTS_READ]
        }
      ))
      ;({ key: readsNothing } = await createPluginKey(owner, {
        storeId: ctx.storeA.id,
        pluginId: `${pluginId}-none`,
        scopes: [PluginScopes.INVENTORY_READ]
      }))
      const admin = await adminOf(owner, ctx.storeA.id)
      ownExport = await exportRow(ctx.storeA.id, `plugin:${installationA}`)
      ownExportOfAnotherInstallation = await exportRow(ctx.storeA.id, `plugin:${randomUUID()}`)
      exportOfAPerson = await exportRow(ctx.storeA.id, admin)
      exportOfB = await exportRow(ctx.storeB.id, `plugin:${randomUUID()}`)
      // A kind the key holds no scope for any more: its own row, and still a 404
      exportOfLostKind = await exportRow(
        ctx.storeA.id,
        `plugin:${installationOnlyRead}`,
        ExportTypes.ANALYTICS
      )
      fileA = await fileOf(ctx.storeA.id)
      fileB = await fileOf(ctx.storeB.id)
    })
    afterAll(async () => {
      await owner.export.deleteMany({
        where: {
          requestedBy: { startsWith: 'plugin:' },
          storeId: { in: [ctx.storeA.id, ctx.storeB.id] }
        }
      })
      await owner.pluginInstallation.deleteMany({ where: { pluginId: { startsWith: pluginId } } })
      await owner.plugin.deleteMany({ where: { id: { startsWith: pluginId } } })
    })

    it('reads its own export and no one else: not a person, not another installation, not another store', async () => {
      expect((await get(keyOfA, PluginApiRoutes.exports.byId(ownExport))).status).toBe(200)
      for (const other of [exportOfAPerson, ownExportOfAnotherInstallation, exportOfB]) {
        expect((await get(keyOfA, PluginApiRoutes.exports.byId(other))).status).toBe(404)
        expect((await get(keyOfA, PluginApiRoutes.exports.download(other))).status).toBe(404)
      }
      const list = idsOf(await get(keyOfA, PluginApiRoutes.exports.list))
      expect(list).toContain(ownExport)
      expect(list).not.toContain(exportOfAPerson)
      expect(list).not.toContain(ownExportOfAnotherInstallation)
      expect(list).not.toContain(exportOfB)
    })

    it('does not read, with the key of the other store, an export of this one', async () => {
      expect((await get(keyOfB, PluginApiRoutes.exports.byId(ownExport))).status).toBe(404)
      expect(idsOf(await get(keyOfB, PluginApiRoutes.exports.list))).not.toContain(ownExport)
      expect((await get(keyOfA2, PluginApiRoutes.exports.byId(ownExport))).status).toBe(404)
    })

    it('does not show a person the exports of a plugin, in the centre or by id', async () => {
      const list = await api(app, ctx.adminA, ctx.storeA).get(ApiRoutes.exports.list)
      const byId = await api(app, ctx.adminA, ctx.storeA).get(ApiRoutes.exports.byId(ownExport))

      expect(JSON.stringify(list.body)).not.toContain(ownExport)
      expect(byId.status).toBe(404)
    })

    it('stops showing the kinds whose scope the key does not hold, as a role that lost the permission does', async () => {
      expect(
        (await get(readsExportsOnly, PluginApiRoutes.exports.byId(exportOfLostKind))).status
      ).toBe(404)
      expect(idsOf(await get(readsExportsOnly, PluginApiRoutes.exports.list))).not.toContain(
        exportOfLostKind
      )
    })

    it('asks for the figures as a file for the store of the key, owned by the installation, and never names who in the row', async () => {
      const asked = await get(keyOfA, PluginApiRoutes.analytics.export).query(analyticsQuery)
      const named = await get(keyOfA, PluginApiRoutes.analytics.export).query({
        ...analyticsQuery,
        storeId: ctx.storeB.id
      })

      expect(asked.status).toBe(202)
      expect(named.status).toBeGreaterThanOrEqual(400)
      const row = await owner.export.findUniqueOrThrow({
        where: { id: (asked.body as { id: string }).id }
      })
      expect([row.storeId, row.requestedBy, row.type]).toEqual([
        ctx.storeA.id,
        `plugin:${installationA}`,
        ExportTypes.ANALYTICS
      ])
      expect(JSON.stringify(asked.body)).not.toContain(installationA)
    })

    it('lets an installation have one export in progress, so that it cannot take the slots of the people of the store', async () => {
      const again = await get(keyOfA, PluginApiRoutes.analytics.export).query(analyticsQuery)
      const other = await get(keyOfA2, PluginApiRoutes.analytics.export).query(analyticsQuery)

      expect(again.status).toBe(429)
      expect(other.status).toBe(202)
    })

    it('needs both scopes to take the figures out, and the scope of each route to read', async () => {
      const metrics = await get(keyOfA, PluginApiRoutes.analytics.metrics).query({})
      const withoutExport = await createPluginKey(owner, {
        storeId: ctx.storeA.id,
        pluginId: `${pluginId}-no-export`,
        scopes: [PluginScopes.ANALYTICS_READ, PluginScopes.EXPORTS_READ]
      })
      const refused = await get(withoutExport.key, PluginApiRoutes.analytics.export).query(
        analyticsQuery
      )

      expect(metrics.status).not.toBe(403)
      expect(refused.status).toBe(403)
      expect((await get(readsNothing, PluginApiRoutes.exports.list)).status).toBe(403)
      expect((await get(readsNothing, PluginApiRoutes.analytics.metrics).query({})).status).toBe(
        403
      )
      expect((await get(readsNothing, PluginApiRoutes.media.byId(fileA))).status).toBe(403)
    })

    it('gives the signed links of a file of its own store only, and none of another store', async () => {
      const own = await get(keyOfA, PluginApiRoutes.media.byId(fileA))
      const foreign = await get(keyOfA, PluginApiRoutes.media.byId(fileB))
      const fromB = await get(keyOfB, PluginApiRoutes.media.byId(fileA))

      expect(own.status).toBe(200)
      expect(foreign.status).toBe(404)
      expect(fromB.status).toBe(404)
      expect((own.body as { url: string }).url).toMatch(/^https?:\/\//)
      // Signed, and for minutes: an address that anyone could open without the signature is never given
      expect((own.body as { url: string }).url).toContain('X-Amz-Signature=')
      expect((own.body as { url: string }).url).toContain('X-Amz-Expires=')
    })

    it('signs an upload inside the store of the key, owned by the installation, and refuses the purposes its scope does not lend', async () => {
      const body = {
        purpose: 'message',
        filename: 'photo.png',
        contentType: 'image/png',
        fileSizeBytes: 68
      }
      const own = await post(keyOfA, PluginApiRoutes.media.uploadUrl).send(body)
      const product = await post(keyOfA, PluginApiRoutes.media.uploadUrl).send({
        purpose: 'product',
        parentId: randomUUID(),
        filename: 'photo.png',
        contentType: 'image/png',
        fileSizeBytes: 68
      })
      const named = await post(keyOfA, PluginApiRoutes.media.uploadUrl).send({
        ...body,
        storeId: ctx.storeB.id
      })

      expect(own.status).toBe(200)
      expect((own.body as { key: string }).key).toMatch(
        new RegExp(`^${StorageKeys.storePrefix(ctx.storeA.id)}uploads/`)
      )
      expect(product.status).toBe(403)
      expect(named.status).toBe(400)
    })

    it('does not confirm the object of another store, and writes no row in either', async () => {
      const mediaId = randomUUID()
      const response = await post(keyOfA, PluginApiRoutes.media.confirmUpload).send({
        purpose: 'message',
        filename: 'photo.png',
        contentType: 'image/png',
        fileSizeBytes: 68,
        mediaId,
        key: StorageKeys.messageUpload(ctx.storeB.id, mediaId, 'photo.png')
      })

      expect(response.status).toBe(403)
      expect(await owner.media.count({ where: { id: mediaId } })).toBe(0)
    })

    it('answers 404 for a customer of another store on the ZIP of a gallery, and makes no export', async () => {
      const foreign = await createCustomer(owner, { storeId: ctx.storeB.id })
      const before = await owner.export.count({ where: { storeId: ctx.storeA.id } })

      const zip = await post(keyOfA, PluginApiRoutes.media.downloadAll).send({
        customerId: foreign.id
      })

      expect(zip.status).toBe(404)
      expect(await owner.export.count({ where: { storeId: ctx.storeA.id } })).toBe(before)
    })

    it('has no route for the other kinds of export nor for the scheduled reports', async () => {
      for (const path of [
        '/plugin-api/customers/export',
        '/plugin-api/orders/export',
        '/plugin-api/analytics/reports'
      ]) {
        expect((await get(keyOfA, path)).status).not.toBe(200)
      }
    })
  })

  // A plugin the owner registers by pasting its manifest belongs to the organization (Step 5.6, P1). The catalog and the
  // install of another organization never reach it; the generic matrix above cannot hold it, because a plugin has no
  // route to read it by id: the answer of the install is the one of a plugin that does not exist.
  describe('a private plugin', () => {
    const pluginId = `${prefix}-priv`

    beforeAll(async () => {
      await owner.plugin.create({
        data: {
          id: pluginId,
          name: 'Private plugin',
          authorName: 'suite',
          authorEmail: 'suite@example.invalid',
          type: PluginCatalogTypes.INTEGRATION,
          manifest: {},
          pricingModel: PluginPricingModels.FREE,
          status: PluginStatus.APPROVED,
          organizationId: ctx.orgA.id
        }
      })
    })
    afterAll(async () => {
      await owner.plugin.deleteMany({ where: { id: pluginId } })
    })

    const idsSeenBy = async (user: TestContext['adminA'], store: TestContext['storeA']) => {
      const response = await api(app, user, store).get(ApiRoutes.plugins.available)
      expect(response.status).toBe(200)
      return (response.body as { id: string }[]).map(entry => entry.id)
    }

    it('is in the catalog of its organization and not in the one of another', async () => {
      expect(await idsSeenBy(ctx.adminA, ctx.storeA)).toContain(pluginId)
      expect(await idsSeenBy(ctx.adminB, ctx.storeB)).not.toContain(pluginId)
    })

    it('is not installed by another organization, and answers as a plugin that does not exist', async () => {
      const foreign = await api(app, ctx.adminB, ctx.storeB)
        .post(ApiRoutes.plugins.install)
        .send({ pluginId })
      const missing = await api(app, ctx.adminB, ctx.storeB)
        .post(ApiRoutes.plugins.install)
        .send({ pluginId: `${prefix}-nobody` })

      expect(foreign.status).toBe(404)
      expect((foreign.body as { error: unknown }).error).toEqual(
        (missing.body as { error: unknown }).error
      )
      expect(await owner.pluginInstallation.count({ where: { pluginId } })).toBe(0)
    })

    it('is not registered over by another organization', async () => {
      const response = await api(app, ctx.adminB, ctx.storeB)
        .post(ApiRoutes.plugins.register)
        .send({
          id: pluginId,
          version: '9.9.9',
          name: 'Taken over',
          description: 'x',
          author: { name: 'x', email: 'x@example.com' },
          type: PluginCatalogTypes.INTEGRATION,
          pricing: { model: PluginPricingModels.FREE },
          scopes: []
        })

      expect(response.status).toBe(409)
      expect((await owner.plugin.findUniqueOrThrow({ where: { id: pluginId } })).name).toBe(
        'Private plugin'
      )
    })
  })

  // The routes that decide a data request, tried with the id of a request of another store (Step 7.2-H1b, rule 3): the id of another
  // organization, of a sibling store, and of the own store's claim of one in another store are the same 404 as an id that does not exist, and
  // the request does not change
  describe('data subject requests', () => {
    const decisions: {
      name: string
      path: (id: string) => string
      body: Record<string, unknown>
      row: (owner: OwnerClient, storeId: string) => Promise<{ id: string }>
    }[] = [
      {
        name: 'approve',
        path: ApiRoutes.compliance.dsrApprove,
        body: { confirm: true, reason: 'isolation-suite' },
        row: (owner, storeId) => createDataSubjectRequest(owner, { storeId })
      },
      {
        name: 'reject',
        path: ApiRoutes.compliance.dsrReject,
        body: { reason: 'isolation-suite' },
        row: (owner, storeId) => createDataSubjectRequest(owner, { storeId })
      },
      {
        name: 'cancel',
        path: ApiRoutes.compliance.dsrCancel,
        body: { reason: 'isolation-suite' },
        row: (owner, storeId) =>
          createDataSubjectRequest(owner, {
            storeId,
            status: DsrStatus.IN_PROGRESS,
            erasureDueAt: new Date(Date.now() + 86_400_000)
          })
      }
    ]

    it.each(decisions)(
      "$name: another store's request is a 404 that changes nothing",
      async decision => {
        const inB = await decision.row(owner, ctx.storeB.id)
        const inSibling = await decision.row(owner, ctx.storeA2.id)
        const missing = await api(app, ctx.adminA, ctx.storeA)
          .post(decision.path(randomUUID()))
          .send(decision.body)

        for (const row of [inB, inSibling]) {
          const response = await api(app, ctx.adminA, ctx.storeA)
            .post(decision.path(row.id))
            .send(decision.body)
          expect(response.status).toBe(404)
          // Not an existence oracle: the very answer of an id that exists nowhere
          expect((response.body as { error: unknown }).error).toEqual(
            (missing.body as { error: unknown }).error
          )
          const after = await owner.dataSubjectRequest.findUniqueOrThrow({ where: { id: row.id } })
          expect(after.notes).toBe(DSR_FIXTURE_NOTE)
          expect(after.reviewedBy).toBeNull()
          expect(after.notifyToEncrypted).toBeNull()
        }
        // Naming the other store in the header is refused before the request is looked at
        const naming = await api(app, ctx.adminA, ctx.storeB)
          .post(decision.path(inB.id))
          .send(decision.body)
        expect(naming.status).toBe(403)
      }
    )

    // The file of a finished export (Step 7.2-H2b-2): the signed link is asked for by the id of the request under the store of the guard
    it("export link: another store's finished export is the 404 of an id that does not exist, and no link is audited", async () => {
      const exportOf = async (storeId: string) => {
        const row = await createDataSubjectRequest(owner, { storeId, status: DsrStatus.COMPLETED })
        await owner.dataSubjectRequest.update({
          where: { id: row.id },
          data: {
            type: DsrType.ACCESS,
            resultKey: StorageKeys.dsrExport(row.id),
            resultExpiresAt: new Date(Date.now() + 86_400_000)
          }
        })
        return row
      }
      const inB = await exportOf(ctx.storeB.id)
      const inSibling = await exportOf(ctx.storeA2.id)
      const own = await exportOf(ctx.storeA.id)
      const missing = await api(app, ctx.adminA, ctx.storeA).get(
        ApiRoutes.compliance.dsrExport(randomUUID())
      )

      for (const row of [inB, inSibling]) {
        const response = await api(app, ctx.adminA, ctx.storeA).get(
          ApiRoutes.compliance.dsrExport(row.id)
        )
        expect(response.status).toBe(404)
        expect((response.body as { error: unknown }).error).toEqual(
          (missing.body as { error: unknown }).error
        )
        expect(
          await owner.auditLog.count({
            where: { action: AuditAction.DSR_EXPORT_DOWNLOADED, resourceId: row.id }
          })
        ).toBe(0)
        // Naming the other store in the header is refused before the request is looked at
        const naming = await api(app, ctx.adminA, ctx.storeB).get(
          ApiRoutes.compliance.dsrExport(row.id)
        )
        expect(naming.status).toBe(403)
      }
      // The own store's is found: the filter is the store and not the type of the route
      expect(
        (await api(app, ctx.adminA, ctx.storeA).get(ApiRoutes.compliance.dsrExport(own.id))).status
      ).toBe(200)
    })
  })

  // The cold parts of the audit log (Step 7.2-K) hold the rows of every store in one object: the viewer keeps each row by its own
  // store, not by the file, and a row with no store is nobody's
  describe('the cold parts of the audit log', () => {
    const year = 1972
    const key = StorageKeys.auditArchive(year, 5)
    const ids = { a: randomUUID(), a2: randomUUID(), b: randomUUID(), none: randomUUID() }
    const range = `from=${year}-05-01T00:00:00.000Z&before=${year}-06-01T00:00:00.000Z`
    const at = `at=${encodeURIComponent(`${year}-05-10T00:00:00.000Z`)}`
    let storage: StorageService

    beforeAll(async () => {
      storage = app.get(StorageService)
      await owner.store.updateMany({
        where: { id: { in: [ctx.storeA.id, ctx.storeA2.id, ctx.storeB.id] } },
        data: { createdAt: new Date(`${year - 1}-01-01T00:00:00.000Z`) }
      })
      const line = (id: string, storeId: string | null) =>
        JSON.stringify({
          id,
          action: `${prefix}.cold`,
          userId: null,
          storeId,
          organizationId: null,
          resourceType: null,
          resourceId: null,
          metadata: null,
          ipAddress: null,
          userAgent: null,
          timestamp: `${year}-05-10T00:00:00.000Z`
        })
      const lines = [
        line(ids.a, ctx.storeA.id),
        line(ids.a2, ctx.storeA2.id),
        line(ids.b, ctx.storeB.id),
        line(ids.none, null)
      ]
      await storage.put(key, gzipSync(`${lines.join('\n')}\n`), 'application/gzip')
    })
    afterAll(async () => {
      await storage.delete(key)
    })

    it('lists only the rows of the store of the request, even from the same file, a sibling store or another organization', async () => {
      const read = async (actor: typeof ctx.adminA, store: typeof ctx.storeA) =>
        (
          (await api(app, actor, store).get(`${ApiRoutes.organizations.auditLog}?${range}`))
            .body as { data: { id: string }[] }
        ).data.map(item => item.id)

      expect(await read(ctx.adminA, ctx.storeA)).toEqual([ids.a])
      expect(await read(ctx.adminA2, ctx.storeA2)).toEqual([ids.a2])
      expect(await read(ctx.adminB, ctx.storeB)).toEqual([ids.b])
    })

    it('answers the same 404 for the row of another store, one with no store and one that does not exist', async () => {
      const get = async (id: string) =>
        (
          await api(app, ctx.adminA, ctx.storeA).get(
            `${ApiRoutes.organizations.auditLogEntry(id)}?${at}`
          )
        ).status
      expect(await get(ids.a)).toBe(HttpStatusCodes.OK)
      expect(await get(ids.a2)).toBe(HttpStatusCodes.NOT_FOUND)
      expect(await get(ids.b)).toBe(HttpStatusCodes.NOT_FOUND)
      expect(await get(ids.none)).toBe(HttpStatusCodes.NOT_FOUND)
      expect(await get(randomUUID())).toBe(HttpStatusCodes.NOT_FOUND)
    })
  })
})
