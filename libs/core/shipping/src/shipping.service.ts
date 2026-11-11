import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { CredentialCipher } from '@platform/core/crypto'
import {
  isUniqueViolation,
  lockStoreForWrite,
  lockStoreScope,
  PrismaService,
  type PrismaTransaction
} from '@platform/core/database'
import {
  BulkLabelLimits,
  CarrierCapability,
  CarrierConnectionStatus,
  CarrierHealthReasons,
  GuideRefundStatus,
  cancelShipmentKey,
  PickupDefaults,
  pickupBatchKey,
  PickupStatus,
  ShipmentEventSource,
  ShipmentEventNotes,
  ShipmentFailureReasons,
  ShipmentInactiveStatuses,
  ShipmentKind,
  ShipmentLimits,
  ShipmentLockScopes,
  ShipmentPastPickupStatuses,
  ShipmentStatus,
  ShipmentUnknownOutcomeStatuses,
  type SetShipmentStatusBody
} from '@platform/core/domain'
import {
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  resourceNotFound
} from '@platform/core/errors'
import type { ActorRef } from '@platform/core/events'
import { DEFAULT_LOCALE, type Locale, SUPPORTED_LOCALES } from '@platform/core/i18n'
import {
  CarrierAuthError,
  CarrierRejectedError,
  type CancelShipmentResult,
  type CarrierContext,
  type CarrierLabel,
  type CarrierPlugin,
  type CreateShipmentParams,
  type CreateShipmentResult,
  type LabelInput,
  type PickupBatchResult,
  LabelPaymentKinds,
  PickupBatchOutcomes,
  type ShipmentCreationMode,
  ShipmentCreationModes
} from '@platform/plugins/sdk'

import { callCreate, withDeadline } from './carrier-call'
import { buildCarrierContext, CarrierCredentialsUnreadableError } from './carrier-context'
import { takeLocalGuideNumber } from './guide-numbering'
import { LabelRenderError } from './label-fit'
import { renderLabelPdf } from './label-pdf'
import { labelTextsFor } from './label-texts'
import { type StoredLabel, ShipmentLabels } from './shipment-labels'
import {
  type PluginLookup,
  prepareGuide,
  type PreparedGuide,
  type ShipmentCaller,
  type ShipmentRequest,
  shippingRefusal,
  type StoreFacts
} from './shipment-prepare'
import {
  CarrierCallOutcomes,
  classifyCarrierError,
  clampCarrierMessage,
  failureReasonOf,
  isShipmentTransitionAllowed,
  isUsableGuideNumber,
  nextPickupDate
} from './shipment-rules'
import { type ShipmentIdentity, ShipmentWrites } from './shipment-writes'

// What happened to one request of `createShipments`: a guide in the status it ended in, or the refusal that stopped it. A
// refusal that came after the row was written (the carrier refused it, or nobody knows) names the shipment.
export type ShipmentOutcome =
  | { ok: true; orderId: string; shipmentId: string; status: ShipmentStatus }
  | { ok: false; orderId: string; error: PlatformException; shipmentId?: string }

// Where a request would send its guide and at what pace its carrier takes them (`routesOf`)
export interface ShipmentRoute {
  connectionId: string
  mode: ShipmentCreationMode
  // The most guides to ask of this connection at the same time (standalone and internal carriers; a pickup-bound one gets one
  // call per batch)
  concurrency: number
}

export interface ShipmentChange {
  shipmentId: string
  orderId: string
  from: ShipmentStatus
  to: ShipmentStatus
}

// A row that is still CREATING after this long was not left by a call in flight (a call gives up after the deadline times
// the attempts, and a pickup batch records its entries one after another): an agent may settle it
const CREATING_STALE_MS = 30 * 60 * 1000
// A cancel that asked nobody (the process died after it was written) may be asked again after this, never before: the call
// may still be in flight
const CANCEL_STALE_MS = 5 * 60 * 1000

function safeTrackingUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 500) return null
  try {
    return new URL(value).protocol === 'https:' ? value : null
  } catch {
    return null
  }
}

function moneyText(cents: number, currency: string, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(cents / 100)
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`
  }
}

function localeOf(value: string): Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value)
    ? (value as Locale)
    : DEFAULT_LOCALE
}

function isLabelProblem(error: unknown): boolean {
  return (
    error instanceof LabelRenderError ||
    (error instanceof Error && error.name === 'LabelLayoutError')
  )
}

// What a plugin promised for one shipment of a pickup batch (TDD_17 §4.5), checked at run time: a plugin is not trusted
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isCreatedEntry(
  value: unknown
): value is { outcome: typeof PickupBatchOutcomes.CREATED; shipment: CreateShipmentResult } {
  return (
    isObject(value) &&
    value['outcome'] === PickupBatchOutcomes.CREATED &&
    isObject(value['shipment'])
  )
}

function isRejectedEntry(
  value: unknown
): value is { outcome: typeof PickupBatchOutcomes.REJECTED; message: string } {
  return (
    isObject(value) &&
    value['outcome'] === PickupBatchOutcomes.REJECTED &&
    typeof value['message'] === 'string'
  )
}

// The label of a `local` guide is drawn and put in the bucket inside the transaction that gives the number (it must come
// back with it), so the transaction gets more room than the default (TDD_17 §4.2)
const LOCAL_GUIDE_TRANSACTION = { timeout: 20_000 } as const
// A pickup batch judges and writes up to fifty orders in one transaction, and the wait for the lock of each counts
const BATCH_TRANSACTION = { timeout: 30_000 } as const

interface Batchable {
  index: number
  request: ShipmentRequest
}

// The engine that makes guides and moves them forward (TDD_17 §4.5, §4.8, §4.9). It is the only writer of the status of a
// shipment and of a pickup. A guide may cost money, so the order of things never changes: the row is written first (and
// committed, so a crash leaves a visible row and never an invisible guide), the carrier is called second and at most once
// unless it promised an idempotent create, and a call whose outcome is unknown is never answered with a second guide.
@Injectable()
export class ShippingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: CredentialCipher,
    private readonly writes: ShipmentWrites,
    private readonly labels: ShipmentLabels,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(ShippingService.name)
  }

  // ------------------------------------------------------------------------------------------ creating

  // The only way a guide comes into being (a single one is a batch of one). One outcome per request, in order. The request
  // that names no connection takes the planned carrier of its order, then the default of the store.
  async createShipments(
    storeId: string,
    requests: readonly ShipmentRequest[],
    caller: ShipmentCaller,
    plugins: PluginLookup
  ): Promise<ShipmentOutcome[]> {
    if (requests.length === 0 || requests.length > ShipmentLimits.MAX_REQUESTS) {
      throw new PlatformException(
        ErrorCodes.VALIDATION_INVALID_INPUT,
        'a batch takes between one and a hundred shipments',
        HttpStatusCodes.BAD_REQUEST
      )
    }
    const store = await this.storeFacts(storeId)
    const outcomes: (ShipmentOutcome | undefined)[] = new Array<ShipmentOutcome | undefined>(
      requests.length
    ).fill(undefined)

    const connectionOf = await this.connectionsOf(storeId, requests)
    const pickupBound = new Map<string, Batchable[]>()
    for (const [index, request] of requests.entries()) {
      const resolved = connectionOf.get(request.orderId)
      const connectionId = request.connectionId ?? resolved
      if (connectionId === undefined || connectionId === null) {
        outcomes[index] = this.refused(
          request.orderId,
          shippingRefusal(ErrorCodes.SHIPPING_CARRIER_REQUIRED, 'no carrier was chosen')
        )
        continue
      }
      const carrierId = await this.carrierOf(storeId, connectionId)
      const plugin = carrierId === null ? undefined : plugins(carrierId)
      if (plugin === undefined) {
        outcomes[index] = this.refused(
          request.orderId,
          carrierId === null
            ? resourceNotFound('carrier')
            : shippingRefusal(
                ErrorCodes.SHIPPING_CARRIER_NOT_ACTIVE,
                'the carrier is not available'
              )
        )
        continue
      }
      if (plugin.shipmentCreation === ShipmentCreationModes.PICKUP_BOUND) {
        const group = pickupBound.get(connectionId) ?? []
        group.push({ index, request })
        pickupBound.set(connectionId, group)
        continue
      }
      outcomes[index] = await this.createOne(store, request, connectionId, caller, plugins)
    }
    for (const [connectionId, group] of pickupBound) {
      const carrierId = await this.carrierOf(storeId, connectionId)
      const plugin = carrierId === null ? undefined : plugins(carrierId)
      if (plugin === undefined) continue
      for (const [index, outcome] of await this.createPickupBatches(
        store,
        connectionId,
        group,
        caller,
        plugin,
        plugins
      )) {
        outcomes[index] = outcome
      }
    }
    return outcomes.map((outcome, index) =>
      outcome === undefined
        ? this.refused(
            requests[index]?.orderId ?? '',
            new PlatformException(
              ErrorCodes.SHIPPING_CARRIER_NOT_ACTIVE,
              'the shipment was not made',
              HttpStatusCodes.CONFLICT
            )
          )
        : outcome
    )
  }

  // Where each request would send its guide: the connection (the one asked for, else the planned carrier of the order, else the
  // default one of the store) and how its carrier makes guides. A request with no connection, or whose carrier is not available,
  // is left out: asking for its guide gives the refusal. A caller that makes many guides at once (a bulk run) uses this to keep
  // the pace the carrier allows; nothing here writes or calls a carrier.
  async routesOf(
    storeId: string,
    requests: readonly ShipmentRequest[],
    plugins: PluginLookup
  ): Promise<Map<string, ShipmentRoute>> {
    const planned = await this.connectionsOf(storeId, requests)
    const carriers = new Map<string, string | null>()
    const routes = new Map<string, ShipmentRoute>()
    for (const request of requests) {
      const connectionId = request.connectionId ?? planned.get(request.orderId) ?? null
      if (connectionId === null) continue
      if (!carriers.has(connectionId)) {
        carriers.set(connectionId, await this.carrierOf(storeId, connectionId))
      }
      const carrierId = carriers.get(connectionId)
      const plugin = carrierId === null || carrierId === undefined ? undefined : plugins(carrierId)
      if (plugin === undefined) continue
      routes.set(request.orderId, {
        connectionId,
        mode: plugin.shipmentCreation,
        concurrency: Math.min(
          plugin.maxConcurrency ?? BulkLabelLimits.DEFAULT_CONCURRENCY,
          BulkLabelLimits.MAX_CONCURRENCY
        )
      })
    }
    return routes
  }

  // The one guide of a standalone or internal carrier
  private async createOne(
    store: StoreFacts,
    request: ShipmentRequest,
    connectionId: string,
    caller: ShipmentCaller,
    plugins: PluginLookup
  ): Promise<ShipmentOutcome> {
    const { storeId } = store
    let prepared: PreparedGuide | undefined
    let shipmentId = ''
    let stored: StoredLabel | null = null
    try {
      const done = await this.prisma.transaction(async tx => {
        await lockStoreForWrite(tx, storeId)
        await lockStoreScope(tx, storeId, `${ShipmentLockScopes.ORDER}:${request.orderId}`)
        prepared = await prepareGuide(tx, store, request, caller, plugins, connectionId)
        shipmentId = await this.writes.insertCreating(tx, prepared.row, caller.actor)
        if (prepared.plugin.shipmentCreation !== ShipmentCreationModes.INTERNAL) return false
        // The core makes the guide and the label, in the transaction that wrote the row: a failure gives the number back
        const identity = { ...prepared.identity, shipmentId }
        const guideNumber = await takeLocalGuideNumber(tx, storeId, connectionId)
        stored = await this.drawLocalLabel(store, prepared, shipmentId, guideNumber)
        await this.labels.record(tx, storeId, prepared.identity.orderId, caller.actor.id, stored)
        await this.writes.move(
          tx,
          identity,
          ShipmentStatus.CREATING,
          ShipmentStatus.LABEL_CREATED,
          { guideNumber, labelMediaId: stored.mediaId },
          { actor: caller.actor, source: ShipmentEventSource.SYSTEM }
        )
        await this.copyTrackingNumber(tx, prepared.identity, guideNumber)
        return true
      }, LOCAL_GUIDE_TRANSACTION)
      if (done)
        return {
          ok: true,
          orderId: request.orderId,
          shipmentId,
          status: ShipmentStatus.LABEL_CREATED
        }
    } catch (error) {
      if (stored !== null) await this.labels.discard(stored)
      return this.refused(request.orderId, this.refusalOf(error))
    }
    if (prepared === undefined) return this.unknownRecord(request.orderId, shipmentId)
    try {
      return await this.callAndRecord(prepared, shipmentId, caller)
    } catch (error) {
      // A plugin that answers with something the code cannot read, or any fault after the carrier may have acted: the guide
      // may exist, so the row goes to review and the batch keeps its other outcomes
      this.logger.error({ shipmentId, err: error }, 'a carrier call ended in a fault')
      return this.settleReview(
        { ...prepared.identity, shipmentId },
        caller,
        ShipmentFailureReasons.UNKNOWN_OUTCOME
      )
    }
  }

  // Calls a standalone carrier and writes down what it answered
  private async callAndRecord(
    prepared: PreparedGuide,
    shipmentId: string,
    caller: ShipmentCaller
  ): Promise<ShipmentOutcome> {
    const { plugin, params } = prepared
    const identity: ShipmentIdentity = { ...prepared.identity, shipmentId }
    let context: CarrierContext
    try {
      context = buildCarrierContext(
        {
          id: prepared.connection.id,
          storeId: prepared.identity.storeId,
          credentials: prepared.connection.credentials,
          contact: prepared.connection.contact
        },
        this.cipher
      )
    } catch (error) {
      return this.settleFailure(identity, [identity], caller, error, null)
    }
    const idempotent = plugin.capabilities.includes(CarrierCapability.IDEMPOTENT_CREATE)
    let result: CreateShipmentResult
    try {
      if (plugin.createShipment === undefined) throw new Error('the plugin has no createShipment')
      const create = plugin.createShipment.bind(plugin)
      result = await callCreate(idempotent, () => create(context, params))
    } catch (error) {
      return this.settleFailure(identity, [identity], caller, error, null)
    }
    return this.recordGuide(prepared, identity, result, context, caller, null)
  }

  // A guide the carrier made, written down: label, tracking, cost and the move to LABEL_CREATED. If the platform cannot
  // write it down the carrier still made it: the shipment goes to review with the reason and the guide is logged, never
  // lost and never made again.
  private async recordGuide(
    prepared: PreparedGuide,
    identity: ShipmentIdentity,
    result: CreateShipmentResult,
    context: CarrierContext,
    caller: ShipmentCaller,
    pickupId: string | null
  ): Promise<ShipmentOutcome> {
    const { storeId, orderId } = identity
    if (typeof result !== 'object' || !isUsableGuideNumber(result.guideNumber)) {
      return this.settleReview(identity, caller, ShipmentFailureReasons.INVALID_ANSWER)
    }
    const guideNumber = result.guideNumber
    let label: CarrierLabel | undefined = result.label
    if (label === undefined && prepared.plugin.fetchLabel !== undefined) {
      try {
        label = await withDeadline(() =>
          (prepared.plugin.fetchLabel as NonNullable<CarrierPlugin['fetchLabel']>)(context, {
            reference: prepared.params.reference,
            guideNumber,
            ...(result.providerShipmentId === undefined
              ? {}
              : { providerShipmentId: result.providerShipmentId }),
            format: prepared.connection.labelFormat
          })
        )
      } catch {
        // The guide exists: the label is asked for again by whoever prints it
        label = undefined
      }
    }
    let stored: StoredLabel | null = null
    try {
      if (label !== undefined) {
        try {
          stored = await this.labels.put(
            storeId,
            identity.shipmentId,
            guideNumber,
            label.data,
            label.contentType,
            false
          )
        } catch (error) {
          // The bucket failed, not the carrier: the guide is recorded without its label, which is asked for again when printed
          this.logger.warn(
            { shipmentId: identity.shipmentId, err: error },
            'the label of a guide could not be stored'
          )
          stored = null
        }
      }
      const cost = result.cost
      const keepsCost =
        cost !== undefined &&
        Number.isInteger(cost.amountCents) &&
        cost.amountCents >= 0 &&
        cost.currency === prepared.row.currency
      if (cost !== undefined && !keepsCost) {
        // A cost the platform cannot keep as reported is never recomputed (TDD_17 §4.12): it is said, once, in the log
        this.logger.warn(
          { shipmentId: identity.shipmentId, currency: cost.currency },
          'a carrier reported a cost the platform cannot keep'
        )
      }
      const providerShipmentId =
        typeof result.providerShipmentId === 'string' && result.providerShipmentId.length <= 200
          ? result.providerShipmentId
          : null
      const recorded = stored
      await this.prisma.transaction(async tx => {
        await lockStoreForWrite(tx, storeId)
        await lockStoreScope(tx, storeId, `${ShipmentLockScopes.ORDER}:${orderId}`)
        if (recorded !== null)
          await this.labels.record(tx, storeId, orderId, caller.actor.id, recorded)
        await this.writes.move(
          tx,
          identity,
          ShipmentStatus.CREATING,
          ShipmentStatus.LABEL_CREATED,
          {
            guideNumber,
            providerShipmentId,
            trackingUrl: safeTrackingUrl(result.trackingUrl),
            carrierCostCents: keepsCost ? cost.amountCents : null,
            labelMediaId: recorded?.mediaId ?? null,
            ...(label !== undefined && recorded === null
              ? { lastError: ShipmentFailureReasons.LABEL_INVALID }
              : {}),
            ...(pickupId === null ? {} : { pickupId })
          },
          { actor: caller.actor, source: ShipmentEventSource.SYSTEM }
        )
        await this.copyTrackingNumber(tx, identity, guideNumber)
      })
      if (stored !== null) await this.queueScan(stored)
      return {
        ok: true,
        orderId,
        shipmentId: identity.shipmentId,
        status: ShipmentStatus.LABEL_CREATED
      }
    } catch (error) {
      if (stored !== null) await this.labels.discard(stored)
      const taken = isUniqueViolation(error)
      this.logger.error(
        { shipmentId: identity.shipmentId, guideNumber, taken, err: error },
        'a carrier made a guide the platform could not record'
      )
      // The guide is kept on the row (unless its number is the one that clashed) so that an agent can find the paid guide
      return this.settleReview(
        identity,
        caller,
        ShipmentFailureReasons.RECORD_FAILED,
        taken ? ErrorCodes.SHIPPING_GUIDE_NUMBER_TAKEN : undefined,
        [identity],
        null,
        taken ? undefined : { guideNumber, providerShipmentId: result.providerShipmentId }
      )
    }
  }

  // The carrier refused, or could not be asked, or did not answer: the row says which. Only a refusal and a call that was
  // never made are "failed"; anything else may have made a guide and is sent to review.
  private async settleFailure(
    identity: ShipmentIdentity,
    batch: readonly ShipmentIdentity[],
    caller: ShipmentCaller,
    error: unknown,
    pickupId: string | null
  ): Promise<ShipmentOutcome> {
    const outcome = classifyCarrierError(error)
    if (outcome === CarrierCallOutcomes.UNKNOWN) {
      this.logger.warn(
        { shipmentId: identity.shipmentId, err: error instanceof Error ? error.name : 'unknown' },
        'the outcome of a carrier call is unknown'
      )
      return this.settleReview(
        identity,
        caller,
        ShipmentFailureReasons.UNKNOWN_OUTCOME,
        undefined,
        batch,
        pickupId
      )
    }
    const rejected = error instanceof CarrierRejectedError
    const message = rejected ? clampCarrierMessage(error.message) : failureReasonOf(outcome)
    try {
      await this.prisma.transaction(async tx => {
        await lockStoreForWrite(tx, identity.storeId)
        for (const entry of batch) {
          await this.writes.move(
            tx,
            entry,
            ShipmentStatus.CREATING,
            ShipmentStatus.FAILED,
            { lastError: message, pickupId: null },
            { actor: caller.actor, source: ShipmentEventSource.SYSTEM }
          )
        }
        if (pickupId !== null) {
          await this.writes.movePickup(
            tx,
            identity.storeId,
            pickupId,
            PickupStatus.PENDING,
            PickupStatus.FAILED,
            {
              lastError: message
            }
          )
        }
        if (
          error instanceof CarrierAuthError ||
          error instanceof CarrierCredentialsUnreadableError
        ) {
          await tx.carrierConnection.updateMany({
            where: {
              id: identity.connectionId,
              storeId: identity.storeId,
              status: CarrierConnectionStatus.ACTIVE
            },
            data: {
              status: CarrierConnectionStatus.ERROR,
              lastError:
                error instanceof CarrierAuthError
                  ? CarrierHealthReasons.AUTH
                  : CarrierHealthReasons.CREDENTIALS_UNREADABLE
            }
          })
        }
      })
    } catch (writeError) {
      this.logger.error(
        { shipmentId: identity.shipmentId, err: writeError },
        'a failed guide could not be written down'
      )
      return this.refused(
        identity.orderId,
        this.outcomeUnknown(identity.shipmentId),
        identity.shipmentId
      )
    }
    const code = rejected
      ? ErrorCodes.SHIPPING_CARRIER_REJECTED
      : ErrorCodes.SHIPPING_CARRIER_CREDENTIALS_INVALID
    return this.refused(
      identity.orderId,
      new PlatformException(
        code,
        'the carrier did not make the guide',
        HttpStatusCodes.BAD_REQUEST,
        {
          shipmentId: identity.shipmentId,
          ...(rejected ? { carrierMessage: message } : { reason: message })
        }
      ),
      identity.shipmentId
    )
  }

  // A guide that may exist: the row, and the rows of its batch, wait for a person (TDD_17 §4.5 step 6)
  private async settleReview(
    identity: ShipmentIdentity,
    caller: ShipmentCaller,
    reason: string,
    code?: typeof ErrorCodes.SHIPPING_GUIDE_NUMBER_TAKEN,
    batch: readonly ShipmentIdentity[] = [identity],
    pickupId: string | null = null,
    // The guide the carrier made and the platform could not record: kept on the row so that the paid guide can be found
    guide?: { guideNumber: string; providerShipmentId?: string | undefined }
  ): Promise<ShipmentOutcome> {
    try {
      await this.prisma.transaction(async tx => {
        await lockStoreForWrite(tx, identity.storeId)
        for (const entry of batch) {
          await this.writes.move(
            tx,
            entry,
            ShipmentStatus.CREATING,
            ShipmentStatus.REQUIRES_REVIEW,
            {
              lastError: reason,
              ...(guide === undefined
                ? {}
                : {
                    guideNumber: guide.guideNumber,
                    providerShipmentId:
                      typeof guide.providerShipmentId === 'string' &&
                      guide.providerShipmentId.length <= 200
                        ? guide.providerShipmentId
                        : null
                  })
            },
            { actor: caller.actor, source: ShipmentEventSource.SYSTEM }
          )
        }
        if (pickupId !== null) {
          await this.writes.movePickup(
            tx,
            identity.storeId,
            pickupId,
            PickupStatus.PENDING,
            PickupStatus.REQUIRES_REVIEW,
            { lastError: reason }
          )
        }
      })
    } catch (error) {
      // The row stays CREATING, which blocks a second guide as REQUIRES_REVIEW does
      this.logger.error(
        { shipmentId: identity.shipmentId, err: error },
        'a review could not be written down'
      )
    }
    const error =
      code === undefined
        ? this.outcomeUnknown(identity.shipmentId)
        : new PlatformException(
            code,
            'the guide number is already used',
            HttpStatusCodes.CONFLICT,
            {
              shipmentId: identity.shipmentId
            }
          )
    return this.refused(identity.orderId, error, identity.shipmentId)
  }

  // The outcome of a whole batch, said again for one of its shipments: its own ids, and the error of the batch with its own
  // shipment in the details (a screen that follows `shipmentId` must reach this one, not the first of the batch)
  private retarget(outcome: ShipmentOutcome, identity: ShipmentIdentity): ShipmentOutcome {
    if (outcome.ok)
      return { ...outcome, orderId: identity.orderId, shipmentId: identity.shipmentId }
    const { error } = outcome
    return {
      ok: false,
      orderId: identity.orderId,
      shipmentId: identity.shipmentId,
      error: new PlatformException(error.code, error.message, error.statusCode, {
        ...error.metadata,
        shipmentId: identity.shipmentId
      })
    }
  }

  private outcomeUnknown(shipmentId: string): PlatformException {
    return new PlatformException(
      ErrorCodes.SHIPPING_OUTCOME_UNKNOWN,
      'the carrier may have made the guide',
      HttpStatusCodes.CONFLICT,
      { shipmentId }
    )
  }

  private unknownRecord(orderId: string, shipmentId: string): ShipmentOutcome {
    return this.refused(orderId, this.outcomeUnknown(shipmentId), shipmentId)
  }

  // ------------------------------------------------------------------------------------------ pickup-bound carriers

  // The shipments of a pickup-bound connection are grouped by the pickup they ride on (the day and hours) and sent in
  // batches of at most the plugin's size: one call carries the pickup and every shipment (TDD_17 §4.5)
  private async createPickupBatches(
    store: StoreFacts,
    connectionId: string,
    group: readonly Batchable[],
    caller: ShipmentCaller,
    plugin: CarrierPlugin,
    plugins: PluginLookup
  ): Promise<Map<number, ShipmentOutcome>> {
    const outcomes = new Map<number, ShipmentOutcome>()
    const rules = await this.prisma.client.carrierConnection.findFirst({
      where: { id: connectionId, storeId: store.storeId },
      select: { pickupDays: true, pickupCutoffTime: true }
    })
    const today = nextPickupDate(new Date(), store.timezone, {
      pickupDays: rules?.pickupDays ?? [],
      pickupCutoffTime: rules?.pickupCutoffTime ?? null
    })
    const fallback = new Intl.DateTimeFormat('en-CA', { timeZone: store.timezone }).format(
      new Date()
    )
    const windows = new Map<string, Batchable[]>()
    for (const item of group) {
      const pickup = item.request.pickup ?? {
        date: today ?? fallback,
        from: PickupDefaults.WINDOW_FROM,
        to: PickupDefaults.WINDOW_TO
      }
      const key = `${pickup.date}|${pickup.from}|${pickup.to}`
      windows.set(key, [...(windows.get(key) ?? []), item])
    }
    const declared = plugin.maxBatchSize
    const size =
      declared !== undefined && Number.isFinite(declared)
        ? Math.max(1, Math.floor(declared))
        : ShipmentLimits.DEFAULT_BATCH_SIZE
    for (const [key, items] of windows) {
      const [date = '', from = '', to = ''] = key.split('|')
      for (let start = 0; start < items.length; start += size) {
        const chunk = items.slice(start, start + size)
        for (const [index, outcome] of await this.createPickupBatch(
          store,
          connectionId,
          chunk,
          { date, from, to },
          caller,
          plugin,
          plugins
        )) {
          outcomes.set(index, outcome)
        }
      }
    }
    return outcomes
  }

  private async createPickupBatch(
    store: StoreFacts,
    connectionId: string,
    chunk: readonly Batchable[],
    window: { date: string; from: string; to: string },
    caller: ShipmentCaller,
    plugin: CarrierPlugin,
    plugins: PluginLookup
  ): Promise<Map<number, ShipmentOutcome>> {
    const { storeId } = store
    const outcomes = new Map<number, ShipmentOutcome>()
    const written: { index: number; prepared: PreparedGuide; identity: ShipmentIdentity }[] = []
    let pickupId = ''
    try {
      await this.prisma.transaction(async tx => {
        await lockStoreForWrite(tx, storeId)
        // In the same order for every batch, so two batches that share orders cannot wait for each other
        const ordered = [...chunk].sort((a, b) =>
          a.request.orderId.localeCompare(b.request.orderId)
        )
        for (const item of ordered) {
          await lockStoreScope(tx, storeId, `${ShipmentLockScopes.ORDER}:${item.request.orderId}`)
        }
        // The pickup first, and each shipment written as soon as it is judged: what the next one reads (the guides the order
        // already has, which decide the amount to collect) must include this one
        const pickup = await tx.pickupRequest.create({
          data: {
            storeId,
            connectionId,
            pickupDate: new Date(`${window.date}T00:00:00.000Z`),
            status: PickupStatus.PENDING,
            packageCount: chunk.length,
            windowStart: window.from,
            windowEnd: window.to,
            requestedBy: caller.actor.id ?? 'system'
          },
          select: { id: true }
        })
        pickupId = pickup.id
        for (const item of chunk) {
          try {
            const prepared = await prepareGuide(
              tx,
              store,
              item.request,
              caller,
              plugins,
              connectionId
            )
            const shipmentId = await this.writes.insertCreating(
              tx,
              { ...prepared.row, pickupId },
              caller.actor
            )
            written.push({
              index: item.index,
              prepared,
              identity: { ...prepared.identity, shipmentId }
            })
          } catch (error) {
            if (!(error instanceof PlatformException)) throw error
            outcomes.set(item.index, this.refused(item.request.orderId, error))
          }
        }
        if (written.length === 0) {
          // Nothing to ask the carrier for: no pickup either
          await tx.pickupRequest.deleteMany({ where: { id: pickupId, storeId } })
          return
        }
        if (written.length !== chunk.length) {
          await tx.pickupRequest.updateMany({
            where: { id: pickupId, storeId },
            data: { packageCount: written.length }
          })
        }
      }, BATCH_TRANSACTION)
    } catch (error) {
      for (const item of chunk) {
        if (!outcomes.has(item.index)) {
          outcomes.set(item.index, this.refused(item.request.orderId, this.refusalOf(error)))
        }
      }
      return outcomes
    }
    if (written.length === 0) return outcomes
    try {
      await this.callPickupBatch(written, pickupId, window, caller, plugin, outcomes)
    } catch (error) {
      // As for a single guide: whatever is not settled yet may have been made, and goes to review one by one
      this.logger.error({ pickupId, err: error }, 'a pickup batch ended in a fault')
      // The pickup waits for a person too, unless the batch already settled it
      try {
        await this.prisma.transaction(async tx => {
          await lockStoreForWrite(tx, store.storeId)
          await this.writes.movePickup(
            tx,
            store.storeId,
            pickupId,
            PickupStatus.PENDING,
            PickupStatus.REQUIRES_REVIEW,
            { lastError: ShipmentFailureReasons.UNKNOWN_OUTCOME }
          )
        })
      } catch {
        // It was settled (or is gone): nothing to move
      }
      for (const entry of written) {
        const settled = outcomes.get(entry.index)
        if (settled !== undefined) continue
        outcomes.set(
          entry.index,
          await this.settleReview(entry.identity, caller, ShipmentFailureReasons.UNKNOWN_OUTCOME)
        )
      }
    }
    return outcomes
  }

  private async callPickupBatch(
    written: readonly { index: number; prepared: PreparedGuide; identity: ShipmentIdentity }[],
    pickupId: string,
    window: { date: string; from: string; to: string },
    caller: ShipmentCaller,
    plugin: CarrierPlugin,
    outcomes: Map<number, ShipmentOutcome>
  ): Promise<void> {
    const identities = written.map(entry => entry.identity)
    const first = written[0]
    if (first === undefined) return
    const settle = async (error: unknown): Promise<void> => {
      const outcome = await this.settleFailure(first.identity, identities, caller, error, pickupId)
      for (const entry of written) {
        outcomes.set(entry.index, this.retarget(outcome, entry.identity))
      }
    }
    let context: CarrierContext
    try {
      context = buildCarrierContext(
        {
          id: first.prepared.connection.id,
          storeId: first.identity.storeId,
          credentials: first.prepared.connection.credentials,
          contact: first.prepared.connection.contact
        },
        this.cipher
      )
    } catch (error) {
      await settle(error)
      return
    }
    const idempotent = plugin.capabilities.includes(CarrierCapability.IDEMPOTENT_CREATE)
    let answer: PickupBatchResult
    try {
      if (plugin.createShipmentsWithPickup === undefined) {
        throw new Error('the plugin has no createShipmentsWithPickup')
      }
      const call = plugin.createShipmentsWithPickup.bind(plugin)
      const shipments: readonly CreateShipmentParams[] = written.map(entry => entry.prepared.params)
      answer = await callCreate(idempotent, () =>
        call(context, {
          idempotencyKey: pickupBatchKey(pickupId),
          pickup: { window, packageCount: written.length },
          shipments
        })
      )
    } catch (error) {
      await settle(error)
      return
    }
    // The answer holds one entry per shipment, in the order sent: anything else is not an answer the platform can use
    const answered: unknown = answer.shipments
    if (
      typeof answer.pickupRef !== 'string' ||
      answer.pickupRef === '' ||
      !Array.isArray(answered) ||
      answered.length !== written.length
    ) {
      const outcome = await this.settleReview(
        first.identity,
        caller,
        ShipmentFailureReasons.INVALID_ANSWER,
        undefined,
        identities,
        pickupId
      )
      for (const entry of written) {
        outcomes.set(entry.index, this.retarget(outcome, entry.identity))
      }
      return
    }
    let made = 0
    let inReview = 0
    for (const [position, entry] of written.entries()) {
      // Each entry is read as what the plugin promised, and anything else is not trusted: a garbled entry may hide a guide
      const raw: unknown = answer.shipments[position]
      let outcome: ShipmentOutcome
      if (isCreatedEntry(raw)) {
        outcome = await this.recordGuide(
          entry.prepared,
          entry.identity,
          raw.shipment,
          context,
          caller,
          pickupId
        )
      } else if (isRejectedEntry(raw)) {
        outcome = await this.settleFailure(
          entry.identity,
          [entry.identity],
          caller,
          new CarrierRejectedError(raw.message),
          null
        )
      } else {
        outcome = await this.settleReview(
          entry.identity,
          caller,
          ShipmentFailureReasons.INVALID_ANSWER
        )
      }
      if (outcome.ok) made += 1
      else if (
        outcome.error.code === ErrorCodes.SHIPPING_OUTCOME_UNKNOWN ||
        outcome.error.code === ErrorCodes.SHIPPING_GUIDE_NUMBER_TAKEN
      ) {
        inReview += 1
      }
      outcomes.set(entry.index, outcome)
    }
    try {
      await this.prisma.transaction(async tx => {
        await lockStoreForWrite(tx, first.identity.storeId)
        // The carrier's own reference to the pickup is kept whatever became of the guides, so that a pickup that exists can be found
        await this.writes.movePickup(
          tx,
          first.identity.storeId,
          pickupId,
          PickupStatus.PENDING,
          made > 0
            ? PickupStatus.REQUESTED
            : inReview > 0
              ? PickupStatus.REQUIRES_REVIEW
              : PickupStatus.FAILED,
          { providerPickupId: answer.pickupRef, packageCount: made }
        )
      })
    } catch (error) {
      this.logger.error(
        { pickupId, providerPickupId: answer.pickupRef, err: error },
        'a pickup could not be written down'
      )
    }
  }

  // ------------------------------------------------------------------------------------------ moving forward

  // A status set by hand (TDD_17 §4.2, §4.9): the same table as a carrier event, from where the agent may. A guide found at
  // the carrier after an unknown outcome is given with `label_created`.
  async setManualStatus(
    storeId: string,
    shipmentId: string,
    body: SetShipmentStatusBody,
    actor: ActorRef
  ): Promise<ShipmentChange> {
    return this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      const row = await this.lockedShipment(tx, storeId, shipmentId)
      const from = row.status as ShipmentStatus
      const to = body.status
      if (
        from === ShipmentStatus.CREATING &&
        Date.now() - row.updatedAt.getTime() < CREATING_STALE_MS
      ) {
        throw this.invalidTransition('the guide is still being made')
      }
      // The table first: a status the shipment cannot reach is a conflict, whatever else the body lacks
      if (!isShipmentTransitionAllowed(from, to)) {
        throw this.invalidTransition(`a shipment cannot go from ${from} to ${to}`)
      }
      // A moment before the guide existed is not a moment of its life
      if (body.occurredAt !== undefined && new Date(body.occurredAt) < row.createdAt) {
        throw new PlatformException(
          ErrorCodes.VALIDATION_INVALID_INPUT,
          'the moment is before the shipment was made',
          HttpStatusCodes.BAD_REQUEST
        )
      }
      const data: Parameters<ShipmentWrites['move']>[4] = {}
      if (to === ShipmentStatus.LABEL_CREATED) {
        if (!isUsableGuideNumber(body.guideNumber)) {
          throw new PlatformException(
            ErrorCodes.VALIDATION_INVALID_INPUT,
            'a guide number is needed',
            HttpStatusCodes.BAD_REQUEST
          )
        }
        data.guideNumber = body.guideNumber
        data.lastError = null
      }
      if (to === ShipmentStatus.FAILED) {
        data.lastError = ShipmentFailureReasons.MARKED_FAILED
        data.pickupId = null
      }
      if (to === ShipmentStatus.FAILED_ATTEMPT) data.failedAttempts = { increment: 1 }
      try {
        await this.writes.move(tx, this.identityOf(row), from, to, data, {
          actor,
          source: ShipmentEventSource.MANUAL,
          description: body.description,
          occurredAt: body.occurredAt === undefined ? undefined : new Date(body.occurredAt)
        })
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new PlatformException(
            ErrorCodes.SHIPPING_GUIDE_NUMBER_TAKEN,
            'the guide number is already used',
            HttpStatusCodes.CONFLICT
          )
        }
        throw error
      }
      if (to === ShipmentStatus.LABEL_CREATED && body.guideNumber !== undefined) {
        await this.copyTrackingNumber(tx, this.identityOf(row), body.guideNumber)
      }
      return { shipmentId, orderId: row.orderId, from, to }
    })
  }

  // The guide is being voided (TDD_17 §4.8). A `local` guide is cancelled at once and for free; a carrier that can void is
  // asked once; one that cannot (or whose connection was disconnected) leaves the shipment CANCEL_PENDING, with the refund
  // not supported, for the agent to void it at the carrier and press "mark as voided".
  async cancel(
    storeId: string,
    shipmentId: string,
    actor: ActorRef,
    plugins: PluginLookup
  ): Promise<ShipmentChange> {
    const started = await this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      const row = await this.lockedShipment(tx, storeId, shipmentId)
      const from = row.status as ShipmentStatus
      if (ShipmentUnknownOutcomeStatuses.includes(from)) {
        throw new PlatformException(
          ErrorCodes.SHIPPING_OUTCOME_UNKNOWN,
          'a guide may exist: resolve it first',
          HttpStatusCodes.CONFLICT
        )
      }
      if (ShipmentPastPickupStatuses.includes(from)) {
        throw new PlatformException(
          ErrorCodes.SHIPPING_CANNOT_CANCEL_AFTER_PICKUP,
          'the package has left',
          HttpStatusCodes.CONFLICT
        )
      }
      // The guide is already being voided: a second request must not call the carrier again
      if (from === ShipmentStatus.CANCEL_PENDING) {
        // Asked again only when nobody can be asking: the carrier could be reached and said nothing was done, or the process
        // that asked is long gone (it is not a guide the carrier cannot void, which is `not_supported`)
        const asked = row.cancelRequestedAt
        const forgotten =
          row.refundStatus !== String(GuideRefundStatus.NOT_SUPPORTED) &&
          asked !== null &&
          Date.now() - asked.getTime() >= CANCEL_STALE_MS
        if (!forgotten) throw this.invalidTransition('the guide is already being cancelled')
        return { row, from }
      }
      await this.writes.move(
        tx,
        this.identityOf(row),
        from,
        ShipmentStatus.CANCEL_PENDING,
        { cancelRequestedAt: new Date(), lastError: null },
        { actor, source: ShipmentEventSource.MANUAL }
      )
      return { row, from }
    })
    const { row } = started
    const identity = this.identityOf(started.row)
    const plugin = plugins(row.connection.carrierId)
    const internal = plugin?.capabilities.includes(CarrierCapability.INTERNAL_GUIDE) === true
    const active = row.connection.status === String(CarrierConnectionStatus.ACTIVE)
    const finish = async (
      to: ShipmentStatus,
      data: Parameters<ShipmentWrites['move']>[4],
      from: ShipmentStatus = ShipmentStatus.CANCEL_PENDING
    ): Promise<ShipmentChange> => {
      await this.prisma.transaction(async tx => {
        await lockStoreForWrite(tx, storeId)
        await this.writes.move(tx, identity, from, to, data, {
          actor,
          source: ShipmentEventSource.MANUAL
        })
      })
      return { shipmentId, orderId: row.orderId, from: started.from, to }
    }
    if (internal) {
      return finish(ShipmentStatus.CANCELLED, {
        cancelledAt: new Date(),
        refundStatus: GuideRefundStatus.NOT_APPLICABLE
      })
    }
    const cancelCall = plugin?.cancelShipment?.bind(plugin)
    const guideNumber = row.guideNumber
    if (
      plugin === undefined ||
      cancelCall === undefined ||
      guideNumber === null ||
      !active ||
      !plugin.capabilities.includes(CarrierCapability.CANCEL_SHIPMENT)
    ) {
      await this.prisma.transaction(async tx => {
        await lockStoreForWrite(tx, storeId)
        await tx.shipment.updateMany({
          where: { id: shipmentId, storeId, status: ShipmentStatus.CANCEL_PENDING },
          data: { refundStatus: GuideRefundStatus.NOT_SUPPORTED }
        })
      })
      return {
        shipmentId,
        orderId: row.orderId,
        from: started.from,
        to: ShipmentStatus.CANCEL_PENDING
      }
    }
    let answer: CancelShipmentResult
    try {
      const context = buildCarrierContext(
        {
          id: row.connection.id,
          storeId,
          credentials: row.connection.credentials,
          contact: row.connection.contact
        },
        this.cipher
      )
      answer = await withDeadline(() =>
        cancelCall(context, {
          reference: row.order.orderNumber,
          guideNumber,
          ...(row.providerShipmentId === null
            ? {}
            : { providerShipmentId: row.providerShipmentId }),
          idempotencyKey: cancelShipmentKey(row.idempotencyKey)
        })
      )
    } catch (error) {
      // The carrier did not void it, or did not say: the shipment keeps holding the order until the agent settles it
      const reason =
        error instanceof CarrierRejectedError
          ? clampCarrierMessage(error.message)
          : failureReasonOf(classifyCarrierError(error))
      return finish(ShipmentStatus.CANCEL_FAILED, { lastError: reason })
    }
    return finish(ShipmentStatus.CANCELLED, {
      cancelledAt: new Date(),
      // Only what the contract allows is kept: a plugin that says anything else is read as a refund still pending
      refundStatus:
        answer.refundStatus === GuideRefundStatus.CONFIRMED
          ? GuideRefundStatus.CONFIRMED
          : GuideRefundStatus.PENDING
    })
  }

  // The agent voided the guide at the carrier himself: HIGH-tier, audited (TDD_17 §4.8)
  async markVoided(storeId: string, shipmentId: string, actor: ActorRef): Promise<ShipmentChange> {
    return this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      const row = await this.lockedShipment(tx, storeId, shipmentId)
      const from = row.status as ShipmentStatus
      await this.writes.move(
        tx,
        this.identityOf(row),
        from,
        ShipmentStatus.CANCELLED,
        { cancelledAt: new Date(), lastError: null },
        { actor, source: ShipmentEventSource.MANUAL }
      )
      return { shipmentId, orderId: row.orderId, from, to: ShipmentStatus.CANCELLED }
    })
  }

  // "Check with the carrier" (TDD_17 §4.5 step 6): asks by the order number for a guide that never came back. Found, the
  // shipment moves to LABEL_CREATED; not found (or ambiguous), it stays in review for the agent to decide.
  async checkWithCarrier(
    storeId: string,
    shipmentId: string,
    actor: ActorRef,
    plugins: PluginLookup
  ): Promise<{ found: boolean; change: ShipmentChange | null }> {
    const row = await this.prisma.client.shipment.findFirst({
      where: { id: shipmentId, storeId },
      select: this.shipmentSelect()
    })
    if (row === null) throw resourceNotFound('shipment')
    if (row.status !== String(ShipmentStatus.REQUIRES_REVIEW)) {
      throw this.invalidTransition('only a guide in review is checked with the carrier')
    }
    const plugin = plugins(row.connection.carrierId)
    if (plugin === undefined || row.connection.status !== String(CarrierConnectionStatus.ACTIVE)) {
      throw shippingRefusal(
        ErrorCodes.SHIPPING_CARRIER_NOT_ACTIVE,
        'the carrier connection is not active'
      )
    }
    if (
      plugin.fetchStatus === undefined ||
      !plugin.capabilities.includes(CarrierCapability.FETCH_STATUS)
    ) {
      throw new PlatformException(
        ErrorCodes.SHIPPING_CHECK_NOT_SUPPORTED,
        'the carrier cannot be asked',
        HttpStatusCodes.CONFLICT
      )
    }
    let guide: { guideNumber: string; providerShipmentId?: string } | null = null
    try {
      const context = buildCarrierContext(
        {
          id: row.connection.id,
          storeId,
          credentials: row.connection.credentials,
          contact: row.connection.contact
        },
        this.cipher
      )
      const fetchStatus = plugin.fetchStatus.bind(plugin)
      const events = await withDeadline(() =>
        fetchStatus(context, [{ reference: row.order.orderNumber }])
      )
      const guides = new Map<string, { guideNumber: string; providerShipmentId?: string }>()
      const cancelled = new Set<string>()
      for (const event of events) {
        // An event of another order (a lookup that matches loosely) is not ours
        if (event.reference !== undefined && event.reference !== row.order.orderNumber) continue
        // A guide the carrier says is cancelled is not the one we are looking for, whatever else it said before
        if (event.status === ShipmentStatus.CANCELLED && isUsableGuideNumber(event.guideNumber)) {
          cancelled.add(event.guideNumber)
          continue
        }
        if (isUsableGuideNumber(event.guideNumber)) {
          guides.set(event.guideNumber, {
            guideNumber: event.guideNumber,
            ...(typeof event.providerShipmentId === 'string' &&
            event.providerShipmentId.length <= 200
              ? { providerShipmentId: event.providerShipmentId }
              : {})
          })
        }
      }
      // The guides the other shipments of the connection already hold are theirs (an order split between warehouses has one per
      // origin and the same order number)
      const held = await this.prisma.client.shipment.findMany({
        where: {
          storeId,
          connectionId: row.connectionId,
          id: { not: shipmentId },
          guideNumber: { not: null }
        },
        select: { guideNumber: true }
      })
      for (const entry of held) {
        if (entry.guideNumber !== null) guides.delete(entry.guideNumber)
      }
      for (const number of cancelled) guides.delete(number)
      // Two guides for one order number: which one is ours is not for the platform to guess
      if (guides.size === 1) guide = [...guides.values()][0] ?? null
    } catch {
      throw new PlatformException(
        ErrorCodes.SHIPPING_CARRIER_UNAVAILABLE,
        'the carrier could not be asked',
        HttpStatusCodes.SERVICE_UNAVAILABLE
      )
    }
    if (guide === null) return { found: false, change: null }
    const found = guide
    let change: ShipmentChange
    try {
      change = await this.prisma.transaction(async tx => {
        await lockStoreForWrite(tx, storeId)
        await lockStoreScope(tx, storeId, `${ShipmentLockScopes.ORDER}:${row.orderId}`)
        await this.writes.move(
          tx,
          this.identityOf(row),
          ShipmentStatus.REQUIRES_REVIEW,
          ShipmentStatus.LABEL_CREATED,
          {
            guideNumber: found.guideNumber,
            providerShipmentId: found.providerShipmentId ?? null,
            lastError: null
          },
          {
            actor,
            source: ShipmentEventSource.MANUAL,
            description: ShipmentEventNotes.FOUND_AT_CARRIER
          }
        )
        await this.copyTrackingNumber(tx, this.identityOf(row), found.guideNumber)
        return {
          shipmentId,
          orderId: row.orderId,
          from: ShipmentStatus.REQUIRES_REVIEW,
          to: ShipmentStatus.LABEL_CREATED
        }
      })
    } catch (error) {
      // The guide the carrier named is already another shipment's: it is not ours to adopt
      if (isUniqueViolation(error)) {
        throw new PlatformException(
          ErrorCodes.SHIPPING_GUIDE_NUMBER_TAKEN,
          'the guide number is already used',
          HttpStatusCodes.CONFLICT
        )
      }
      throw error
    }
    return { found: true, change }
  }

  // ------------------------------------------------------------------------------------------ support

  private shipmentSelect() {
    return {
      id: true,
      storeId: true,
      orderId: true,
      connectionId: true,
      status: true,
      guideNumber: true,
      providerShipmentId: true,
      idempotencyKey: true,
      createdAt: true,
      updatedAt: true,
      cancelRequestedAt: true,
      refundStatus: true,
      order: { select: { orderNumber: true } },
      connection: {
        select: { id: true, carrierId: true, status: true, credentials: true, contact: true }
      }
    } as const
  }

  private async lockedShipment(tx: PrismaTransaction, storeId: string, shipmentId: string) {
    const row = await tx.shipment.findFirst({
      where: { id: shipmentId, storeId },
      select: this.shipmentSelect()
    })
    if (row === null) throw resourceNotFound('shipment')
    await lockStoreScope(tx, storeId, `${ShipmentLockScopes.ORDER}:${row.orderId}`)
    // Read again with the lock held: a change that raced this one is seen
    const fresh = await tx.shipment.findFirst({
      where: { id: shipmentId, storeId },
      select: this.shipmentSelect()
    })
    if (fresh === null) throw resourceNotFound('shipment')
    return fresh
  }

  private identityOf(row: {
    id: string
    storeId: string
    orderId: string
    connectionId: string
    order: { orderNumber: string }
  }): ShipmentIdentity {
    return {
      shipmentId: row.id,
      storeId: row.storeId,
      orderId: row.orderId,
      orderNumber: row.order.orderNumber,
      connectionId: row.connectionId
    }
  }

  private invalidTransition(message: string): PlatformException {
    return new PlatformException(
      ErrorCodes.SHIPPING_INVALID_STATUS_TRANSITION,
      message,
      HttpStatusCodes.CONFLICT
    )
  }

  private refused(orderId: string, error: PlatformException, shipmentId?: string): ShipmentOutcome {
    return { ok: false, orderId, error, ...(shipmentId === undefined ? {} : { shipmentId }) }
  }

  // A refusal is the engine's own answer; a unique violation of the active-guide index is a race it lost; anything else is
  // a fault that must not be answered as a refusal
  private refusalOf(error: unknown): PlatformException {
    if (error instanceof PlatformException) return error
    // Nothing was written and no guide exists: the order lost a race to another guide (a number the carrier made that clashes is
    // `recordGuide`'s case, with the shipment in review)
    if (isUniqueViolation(error)) {
      return new PlatformException(
        ErrorCodes.SHIPPING_ACTIVE_SHIPMENT_EXISTS,
        'the order already has an active guide',
        HttpStatusCodes.CONFLICT
      )
    }
    if (isLabelProblem(error)) {
      return new PlatformException(
        ErrorCodes.SHIPPING_LABEL_UNDRAWABLE,
        'the label cannot be drawn whole',
        HttpStatusCodes.BAD_REQUEST
      )
    }
    // A fault of ours (a deadlock, a timeout): this request fails alone, with nothing of it written, and the outcomes of the
    // others in the batch are not lost. The fault is logged whole.
    this.logger.error({ err: error }, 'a guide could not be made')
    return new PlatformException(
      ErrorCodes.INTERNAL_ERROR,
      'the guide could not be made',
      HttpStatusCodes.INTERNAL_SERVER_ERROR
    )
  }

  private async queueScan(stored: StoredLabel): Promise<void> {
    try {
      await this.labels.queueScan(stored)
    } catch (error) {
      // The row waits as `pending`: the hourly cleanup of the worker queues the scan again
      this.logger.warn(
        { mediaId: stored.mediaId, err: error },
        'the scan of a label could not be queued'
      )
    }
  }

  // The tracking number of the order is the guide of its only shipment (TDD_17 §4.5 step 4). One left by a guide that is over
  // (cancelled, failed, came back) is replaced; one an agent typed is not.
  private async copyTrackingNumber(
    tx: PrismaTransaction,
    identity: Omit<ShipmentIdentity, 'shipmentId'>,
    guideNumber: string
  ): Promise<void> {
    const where = {
      orderId: identity.orderId,
      storeId: identity.storeId,
      kind: ShipmentKind.OUTBOUND
    }
    const active = await tx.shipment.count({
      where: { ...where, status: { notIn: [...ShipmentInactiveStatuses] } }
    })
    if (active !== 1) return
    const over = await tx.shipment.findMany({
      where: {
        ...where,
        status: { in: [...ShipmentInactiveStatuses] },
        guideNumber: { not: null }
      },
      select: { guideNumber: true }
    })
    const stale = over.flatMap(entry => (entry.guideNumber === null ? [] : [entry.guideNumber]))
    await tx.order.updateMany({
      where: {
        id: identity.orderId,
        storeId: identity.storeId,
        OR: [{ trackingNumber: null }, { trackingNumber: { in: stale } }]
      },
      data: { trackingNumber: guideNumber }
    })
  }

  // Draws the label of a `local` guide: the plugin places, the core draws (TDD_17 §4.2). The file is put in the bucket before
  // the row is written; a failure after that removes it.
  private async drawLocalLabel(
    store: StoreFacts,
    prepared: PreparedGuide,
    shipmentId: string,
    guideNumber: string
  ): Promise<StoredLabel> {
    const { plugin, label } = prepared
    if (plugin.buildLabelLayout === undefined) throw new Error('the plugin cannot draw a label')
    const locale = localeOf(store.locale)
    const input: LabelInput = {
      format: prepared.connection.labelFormat,
      guideNumber,
      orderNumber: prepared.params.reference,
      sender: {
        name: label.senderName,
        addressLines: label.senderLines,
        ...(label.senderPhone === undefined ? {} : { phone: label.senderPhone })
      },
      recipient: {
        name: label.recipientName,
        addressLines: label.recipientLines,
        phones: label.recipientPhones
      },
      packageCount: prepared.params.packageCount,
      serviceLabel: label.serviceLabel,
      ...(label.notes === undefined ? {} : { notes: label.notes }),
      payment:
        label.codAmountCents === null
          ? { kind: LabelPaymentKinds.PAID }
          : {
              kind: LabelPaymentKinds.COD,
              amountText: moneyText(label.codAmountCents, label.currency, locale)
            },
      texts: labelTextsFor(locale)
    }
    const bytes = await renderLabelPdf(plugin.buildLabelLayout(input))
    const stored = await this.labels.put(
      store.storeId,
      shipmentId,
      guideNumber,
      bytes,
      'application/pdf',
      true
    )
    if (stored === null) throw new Error('a drawn label is always kept')
    return stored
  }

  private async storeFacts(storeId: string): Promise<StoreFacts> {
    const store = await this.prisma.client.store.findUnique({
      where: { id: storeId },
      select: { organizationId: true, timezone: true, defaultLocale: true }
    })
    if (store === null) throw resourceNotFound('store')
    return {
      storeId,
      organizationId: store.organizationId,
      timezone: store.timezone,
      locale: store.defaultLocale
    }
  }

  // The planned carrier of each order, or the default connection of the store (TDD_17 §4.13)
  private async connectionsOf(
    storeId: string,
    requests: readonly ShipmentRequest[]
  ): Promise<Map<string, string | null>> {
    const wanted = requests.filter(request => request.connectionId === undefined)
    const result = new Map<string, string | null>()
    if (wanted.length === 0) return result
    const settings = await this.prisma.client.storeSettings.findUnique({
      where: { storeId },
      select: { defaultCarrierConnectionId: true }
    })
    const orders = await this.prisma.client.order.findMany({
      where: { storeId, id: { in: wanted.map(request => request.orderId) } },
      select: { id: true, carrierConnectionId: true }
    })
    for (const order of orders) {
      result.set(
        order.id,
        order.carrierConnectionId ?? settings?.defaultCarrierConnectionId ?? null
      )
    }
    return result
  }

  private async carrierOf(storeId: string, connectionId: string): Promise<string | null> {
    const row = await this.prisma.client.carrierConnection.findFirst({
      where: { id: connectionId, storeId },
      select: { carrierId: true }
    })
    return row?.carrierId ?? null
  }
}
