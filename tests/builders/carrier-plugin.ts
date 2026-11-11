import { createHmac, timingSafeEqual } from 'node:crypto'

import { z } from 'zod'

import {
  CarrierCapability,
  type CarrierCapabilityType,
  CarrierId,
  type CarrierIdType,
  CarrierWebhookTrust,
  GuideRefundStatus,
  LabelFormat,
  normalizeProviderStatusCode,
  ShipmentStatus,
  ShippingPayer
} from '@platform/core/domain'
import {
  CarrierRejectedError,
  CarrierUnavailableError,
  type CarrierContext,
  type CarrierEvent,
  type CarrierPlugin,
  type CarrierStatusDescriptor,
  type CreateShipmentParams,
  type CreateShipmentResult,
  type PickupBatchEntry,
  PickupBatchOutcomes,
  type PickupGuide,
  PluginTypes,
  type ShipmentCreationMode,
  ShipmentCreationModes
} from '@platform/plugins/sdk'

// What the fake does when a create or a cancel call arrives. Both timeouts end in a CarrierUnavailableError:
// the difference is whether the carrier acted before the connection dropped, which the core cannot see.
export const FakeCarrierBehaviors = {
  OK: 'ok',
  // The carrier refuses: CarrierRejectedError, no guide
  REJECT: 'reject',
  // The call times out before the carrier did anything: no guide exists
  TIMEOUT_BEFORE: 'timeout_before',
  // The carrier made the guide and then the answer was lost: a guide exists the core never heard of
  TIMEOUT_AFTER: 'timeout_after'
} as const
export type FakeCarrierBehavior = (typeof FakeCarrierBehaviors)[keyof typeof FakeCarrierBehaviors]

export interface FakeCarrierOptions {
  // The registry knows three carrier ids; the fake borrows one (FORZA, or C807 when pickup-bound)
  id?: CarrierIdType
  // The `local` carrier is the one internal carrier, and it has its own spec
  mode?: Exclude<ShipmentCreationMode, typeof ShipmentCreationModes.INTERNAL>
  // Declares IDEMPOTENT_CREATE and keeps its promise: the same key never makes a second guide. Without it
  // a repeated call does make one, which is how a test proves the core never retries blindly
  idempotent?: boolean
  // The carrier has no cancel API (no CANCEL_SHIPMENT, no cancelShipment)
  cancel?: boolean
  // The carrier pushes no status (no WEBHOOK_STATUS)
  webhook?: boolean
  fetchStatus?: boolean
  // The webhook sends a shared secret and no signature (as C807 does): the job confirms DELIVERED and RETURNED by asking
  // fetchStatus before it applies them (TDD_17 §4.9). Needs `webhook` and `fetchStatus`
  sharedSecret?: boolean
  // Pickup capabilities, each with the method behind it
  pickupRequest?: boolean
  pickupModify?: boolean
  pickupCancel?: boolean
  cod?: boolean
  maxBatchSize?: number
}

export interface FakeGuide {
  guideNumber: string
  providerShipmentId: string
  reference: string
  idempotencyKey: string
  voided: boolean
  pickupRef: string | null
  // The carrier's own status code, as fetchStatus and the webhook report it
  rawStatus: string
}

export interface FakeCarrierCall {
  method: string
  args: unknown
}

// What a test reads to prove how many guides the carrier really made
export interface FakeCarrierState {
  guides: Map<string, FakeGuide>
  pickups: Map<string, { window: { date: string; from: string; to: string }; packageCount: number }>
  calls: FakeCarrierCall[]
  create: FakeCarrierBehavior
  cancel: FakeCarrierBehavior
  // The references the carrier refuses inside a batch while accepting the rest
  rejectReferences: Set<string>
}

export interface FakeCarrier {
  plugin: CarrierPlugin
  state: FakeCarrierState
  callsTo: (method: string) => FakeCarrierCall[]
  // The carrier moves a guide to one of its own status codes
  setRawStatus: (guideNumber: string, rawStatus: string) => void
  // A signed webhook body for events, as the carrier would send it
  signedWebhook: (events: FakeWebhookEvent[]) => {
    rawBody: string
    headers: Record<string, string>
    body: unknown
  }
}

export const FAKE_CARRIER_SECRET = 'fake-carrier-webhook-secret'
export const FAKE_CARRIER_API_KEY = 'fake-carrier-api-key'

// The statuses the fake documents. `info` is informational: no effect (defaultStatus null)
export const fakeCarrierStatuses: readonly CarrierStatusDescriptor[] = [
  { code: 'created', label: 'Created', defaultStatus: ShipmentStatus.LABEL_CREATED },
  { code: 'picked', label: 'Picked up', defaultStatus: ShipmentStatus.PICKED_UP },
  { code: 'transit', label: 'In transit', defaultStatus: ShipmentStatus.IN_TRANSIT },
  { code: 'out', label: 'Out for delivery', defaultStatus: ShipmentStatus.OUT_FOR_DELIVERY },
  { code: 'failed', label: 'Failed attempt', defaultStatus: ShipmentStatus.FAILED_ATTEMPT },
  { code: 'delivered', label: 'Delivered', defaultStatus: ShipmentStatus.DELIVERED },
  { code: 'returned', label: 'Returned', defaultStatus: ShipmentStatus.RETURNED },
  { code: 'info', label: 'Information', defaultStatus: null }
]

const webhookSchema = z.object({
  events: z.array(
    z.object({
      id: z.string().min(1),
      status: z.string().min(1),
      reason: z.string().optional(),
      guide: z.string().min(1),
      at: z.iso.datetime()
    })
  )
})
export type FakeWebhookEvent = z.input<typeof webhookSchema>['events'][number]

// A plugin method answers with a promise, also when it fails: a refusal is a rejection, never a throw
function settle<T>(run: () => T): Promise<T> {
  return new Promise((resolve, reject) => {
    try {
      resolve(run())
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

// A one-page "PDF": enough bytes for the core to store; the fake draws no label
function labelFor(guideNumber: string, format: CreateShipmentParams['labelFormat']) {
  return {
    format,
    contentType: 'application/pdf',
    data: new TextEncoder().encode(`%PDF-1.4 fake label ${guideNumber}`)
  }
}

// A carrier plugin of the suite. It calls no provider and keeps its guides in memory, with a switch for each way
// a carrier can misbehave (TDD_17 §9): reject, timeout before and after the carrier acted, idempotent create, no
// cancel, no webhook, and the pickup-bound mode.
export function buildFakeCarrier(options: FakeCarrierOptions = {}): FakeCarrier {
  const mode = options.mode ?? ShipmentCreationModes.STANDALONE
  const id =
    options.id ?? (mode === ShipmentCreationModes.PICKUP_BOUND ? CarrierId.C807 : CarrierId.FORZA)
  const idempotent = options.idempotent ?? false
  const withCancel = options.cancel ?? true
  const withWebhook = options.webhook ?? true
  const withFetchStatus = options.fetchStatus ?? true
  const withCod = options.cod ?? true
  const maxBatchSize = options.maxBatchSize ?? 3

  const state: FakeCarrierState = {
    guides: new Map(),
    pickups: new Map(),
    calls: [],
    create: FakeCarrierBehaviors.OK,
    cancel: FakeCarrierBehaviors.OK,
    rejectReferences: new Set()
  }
  let sequence = 0
  let pickupSequence = 0

  const record = (method: string, args: unknown): void => {
    state.calls.push({ method, args })
  }

  // The carrier's side of one create: the guide exists from here on
  const makeGuide = (
    params: CreateShipmentParams,
    pickupRef: string | null
  ): { guide: FakeGuide; result: CreateShipmentResult } => {
    const existing = idempotent
      ? [...state.guides.values()].find(g => g.idempotencyKey === params.idempotencyKey)
      : undefined
    const guide: FakeGuide = existing ?? {
      guideNumber: `FAKE-${String(++sequence).padStart(6, '0')}`,
      providerShipmentId: `prov-${sequence}`,
      reference: params.reference,
      idempotencyKey: params.idempotencyKey,
      voided: false,
      pickupRef,
      rawStatus: 'created'
    }
    state.guides.set(guide.guideNumber, guide)
    return {
      guide,
      result: {
        guideNumber: guide.guideNumber,
        providerShipmentId: guide.providerShipmentId,
        trackingUrl: `https://tracking.fake.invalid/${guide.guideNumber}`,
        cost: { amountCents: 350, currency: 'USD' },
        label: labelFor(guide.guideNumber, params.labelFormat)
      }
    }
  }

  const failBefore = (): void => {
    if (state.create === FakeCarrierBehaviors.REJECT) {
      throw new CarrierRejectedError('The fake carrier refused the shipment')
    }
    if (state.create === FakeCarrierBehaviors.TIMEOUT_BEFORE) {
      throw new CarrierUnavailableError('The fake carrier timed out before acting')
    }
  }
  const failAfter = (): void => {
    if (state.create === FakeCarrierBehaviors.TIMEOUT_AFTER) {
      throw new CarrierUnavailableError('The fake carrier timed out after acting')
    }
  }

  const guidesOfPickup = (pickupRef: string): PickupGuide[] =>
    [...state.guides.values()]
      .filter(g => g.pickupRef === pickupRef)
      .map(g => ({
        reference: g.reference,
        guideNumber: g.guideNumber,
        providerShipmentId: g.providerShipmentId
      }))

  const capabilities: CarrierCapabilityType[] = [
    mode === ShipmentCreationModes.STANDALONE
      ? CarrierCapability.CREATE_SHIPMENT
      : CarrierCapability.PICKUP_BOUND_GUIDES
  ]
  const declare = (on: boolean, capability: CarrierCapabilityType): void => {
    if (on) capabilities.push(capability)
  }
  declare(idempotent, CarrierCapability.IDEMPOTENT_CREATE)
  declare(withCancel, CarrierCapability.CANCEL_SHIPMENT)
  declare(withWebhook, CarrierCapability.WEBHOOK_STATUS)
  declare(withFetchStatus, CarrierCapability.FETCH_STATUS)
  declare(options.pickupRequest === true, CarrierCapability.PICKUP_REQUEST)
  declare(options.pickupModify === true, CarrierCapability.PICKUP_MODIFY)
  declare(options.pickupCancel === true, CarrierCapability.PICKUP_CANCEL)
  declare(withCod, CarrierCapability.COD)

  const plugin: CarrierPlugin = {
    id,
    name: 'Fake carrier',
    version: '1.0.0',
    author: 'suite',
    type: PluginTypes.CARRIER,
    capabilities,
    ...(options.sharedSecret === true ? { webhookTrust: CarrierWebhookTrust.SHARED_SECRET } : {}),
    serviceCatalog: () => [
      { code: 'standard', label: 'Standard', defaultForNextDay: false },
      { code: 'next_day', label: 'Next day', defaultForNextDay: true }
    ],
    statusCatalog: () => fakeCarrierStatuses,

    connect: input => {
      record('connect', { storeId: input.storeId })
      return Promise.resolve({
        displayName: 'Fake carrier account',
        credentials: input.credentials,
        metadata: {}
      })
    },
    disconnect: () => {
      record('disconnect', {})
      return Promise.resolve()
    },
    healthCheck: () => Promise.resolve({ healthy: true, checkedAt: new Date().toISOString() }),

    shipmentCreation: mode,
    ...(mode === ShipmentCreationModes.PICKUP_BOUND ? { maxBatchSize } : {}),

    ...(mode === ShipmentCreationModes.STANDALONE
      ? {
          createShipment: (_ctx: CarrierContext, params: CreateShipmentParams) =>
            settle(() => {
              record('createShipment', params)
              failBefore()
              const { result } = makeGuide(params, null)
              failAfter()
              return result
            })
        }
      : {}),

    ...(mode === ShipmentCreationModes.PICKUP_BOUND
      ? {
          createShipmentsWithPickup: (
            _ctx: CarrierContext,
            params: Parameters<NonNullable<CarrierPlugin['createShipmentsWithPickup']>>[1]
          ) =>
            settle(() => {
              record('createShipmentsWithPickup', params)
              if (params.shipments.length > maxBatchSize) {
                throw new CarrierRejectedError(`A batch takes at most ${maxBatchSize} shipments`)
              }
              failBefore()
              // With PICKUP_MODIFY the shipments join the open pickup of that date; otherwise each call opens its own
              const open =
                options.pickupModify === true
                  ? [...state.pickups.entries()].find(
                      ([, pickup]) => pickup.window.date === params.pickup.window.date
                    )
                  : undefined
              const repeated = idempotent
                ? [...state.guides.values()].find(g =>
                    params.shipments.some(s => s.idempotencyKey === g.idempotencyKey)
                  )
                : undefined
              const pickupRef =
                repeated?.pickupRef ?? open?.[0] ?? `FAKE-PICKUP-${++pickupSequence}`
              const entries: PickupBatchEntry[] = params.shipments.map(shipment =>
                state.rejectReferences.has(shipment.reference)
                  ? {
                      outcome: PickupBatchOutcomes.REJECTED,
                      message: `The fake carrier refused ${shipment.reference}`
                    }
                  : {
                      outcome: PickupBatchOutcomes.CREATED,
                      shipment: makeGuide(shipment, pickupRef).result
                    }
              )
              const created = entries.filter(e => e.outcome === PickupBatchOutcomes.CREATED).length
              // A batch the carrier refused whole is a refusal, not a pickup with no guides
              if (created === 0) {
                throw new CarrierRejectedError(
                  'The fake carrier refused every shipment of the batch'
                )
              }
              state.pickups.set(pickupRef, {
                window: params.pickup.window,
                packageCount: [...state.guides.values()].filter(g => g.pickupRef === pickupRef)
                  .length
              })
              failAfter()
              return { pickupRef, shipments: entries }
            }),
          fetchPickup: (_ctx: CarrierContext, ref: { pickupRef: string }) => {
            record('fetchPickup', ref)
            return Promise.resolve({
              pickupRef: ref.pickupRef,
              shipments: guidesOfPickup(ref.pickupRef)
            })
          }
        }
      : {}),

    ...(withCancel
      ? {
          cancelShipment: (
            _ctx: CarrierContext,
            params: Parameters<NonNullable<CarrierPlugin['cancelShipment']>>[1]
          ) =>
            settle(() => {
              record('cancelShipment', params)
              if (state.cancel === FakeCarrierBehaviors.REJECT) {
                throw new CarrierRejectedError('The fake carrier refused to void the guide')
              }
              if (state.cancel === FakeCarrierBehaviors.TIMEOUT_BEFORE) {
                throw new CarrierUnavailableError('The fake carrier timed out before voiding')
              }
              const guide = state.guides.get(params.guideNumber)
              if (!guide)
                throw new CarrierRejectedError('The fake carrier does not know that guide')
              guide.voided = true
              if (state.cancel === FakeCarrierBehaviors.TIMEOUT_AFTER) {
                throw new CarrierUnavailableError('The fake carrier timed out after voiding')
              }
              return { refundStatus: GuideRefundStatus.PENDING as const }
            })
        }
      : {}),

    fetchLabel: (_ctx, params) => {
      record('fetchLabel', params)
      return Promise.resolve(labelFor(params.guideNumber, params.format))
    },

    ...(withFetchStatus
      ? {
          fetchStatus: (
            _ctx: CarrierContext,
            refs: Parameters<NonNullable<CarrierPlugin['fetchStatus']>>[1]
          ) => {
            record('fetchStatus', refs)
            const events: CarrierEvent[] = []
            for (const ref of refs) {
              const guide = [...state.guides.values()].find(
                g =>
                  (ref.guideNumber !== undefined && g.guideNumber === ref.guideNumber) ||
                  g.reference === ref.reference
              )
              if (!guide) continue
              const known = fakeCarrierStatuses.find(s => s.code === guide.rawStatus)
              events.push({
                providerEventId: `${guide.guideNumber}:${guide.rawStatus}`,
                status: known?.defaultStatus ?? null,
                rawStatus: guide.rawStatus,
                occurredAt: new Date().toISOString(),
                guideNumber: guide.guideNumber,
                providerShipmentId: guide.providerShipmentId,
                reference: guide.reference
              })
            }
            return Promise.resolve(events)
          }
        }
      : {}),

    ...(options.pickupRequest === true
      ? {
          requestPickup: (
            _ctx: CarrierContext,
            params: Parameters<NonNullable<CarrierPlugin['requestPickup']>>[1]
          ) => {
            record('requestPickup', params)
            const pickupRef = `FAKE-PICKUP-${++pickupSequence}`
            state.pickups.set(pickupRef, {
              window: params.window,
              packageCount: params.packageCount
            })
            return Promise.resolve({
              pickupRef,
              window: params.window,
              packageCount: params.packageCount
            })
          }
        }
      : {}),
    ...(options.pickupModify === true
      ? {
          modifyPickup: (
            _ctx: CarrierContext,
            params: Parameters<NonNullable<CarrierPlugin['modifyPickup']>>[1]
          ) =>
            settle(() => {
              record('modifyPickup', params)
              const pickup = state.pickups.get(params.pickupRef)
              if (!pickup)
                throw new CarrierRejectedError('The fake carrier does not know that pickup')
              pickup.packageCount = params.packageCount
              return {
                pickupRef: params.pickupRef,
                window: pickup.window,
                packageCount: pickup.packageCount
              }
            })
        }
      : {}),
    ...(options.pickupCancel === true
      ? {
          cancelPickup: (
            _ctx: CarrierContext,
            params: Parameters<NonNullable<CarrierPlugin['cancelPickup']>>[1]
          ) => {
            record('cancelPickup', params)
            state.pickups.delete(params.pickupRef)
            return Promise.resolve()
          }
        }
      : {}),

    ...(withWebhook
      ? {
          validateWebhookSignature: (
            rawBody: string,
            headers: Record<string, string>,
            secret: string
          ) => {
            // The connection's secret decides, as the core passes it; the fake signs with its own
            const given = Buffer.from(headers['x-signature'] ?? '')
            const expected = Buffer.from(createHmac('sha256', secret).update(rawBody).digest('hex'))
            return given.length === expected.length && timingSafeEqual(given, expected)
          },
          // Pure: it only normalizes the payload
          handleWebhook: (payload: unknown) => {
            const parsed = webhookSchema.safeParse(payload)
            if (!parsed.success) return Promise.resolve([])
            return Promise.resolve(
              parsed.data.events.map((event): CarrierEvent => {
                const known = fakeCarrierStatuses.find(
                  s =>
                    normalizeProviderStatusCode(s.code) ===
                    normalizeProviderStatusCode(event.status)
                )
                return {
                  providerEventId: event.id,
                  status: known?.defaultStatus ?? null,
                  rawStatus: event.status,
                  ...(event.reason === undefined ? {} : { rawReason: event.reason }),
                  occurredAt: event.at,
                  guideNumber: event.guide
                }
              })
            )
          }
        }
      : {})
  }

  return {
    plugin,
    state,
    callsTo: method => state.calls.filter(call => call.method === method),
    setRawStatus: (guideNumber, rawStatus) => {
      const guide = state.guides.get(guideNumber)
      if (guide) guide.rawStatus = rawStatus
    },
    signedWebhook: events => {
      const body = { events }
      const rawBody = JSON.stringify(body)
      return {
        rawBody,
        headers: {
          'x-signature': createHmac('sha256', FAKE_CARRIER_SECRET).update(rawBody).digest('hex')
        },
        body
      }
    }
  }
}

// The params of a create that the fake accepts, for every test that needs "a shipment to make"
export function buildCreateShipmentParams(
  overrides: Partial<CreateShipmentParams> = {}
): CreateShipmentParams {
  return {
    reference: 'ORD-1001',
    idempotencyKey: 'shipment:order-1:warehouse-1:1',
    sender: {
      name: 'Main warehouse',
      address: { line1: '1 Warehouse Rd', city: 'San Salvador', country: 'SV' },
      phone: '22223333'
    },
    recipient: {
      name: 'Ana Recipient',
      phones: ['71234567'],
      address: { line1: '5 Customer St', city: 'Santa Tecla', country: 'SV' }
    },
    packageCount: 1,
    parcels: [{ weightGrams: 800 }],
    serviceCode: 'standard',
    shippingPayer: ShippingPayer.SENDER,
    cod: null,
    labelFormat: LabelFormat.PDF_100X150,
    ...overrides
  }
}

export function buildCarrierContext(overrides: Partial<CarrierContext> = {}): CarrierContext {
  return {
    storeId: 'store-1',
    connectionId: 'connection-1',
    credentials: { apiKey: FAKE_CARRIER_API_KEY },
    metadata: {},
    ...overrides
  }
}
