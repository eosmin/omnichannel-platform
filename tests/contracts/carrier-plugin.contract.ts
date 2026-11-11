import type { PinoLogger } from 'nestjs-pino'

import {
  CarrierCapability,
  CarrierReportableStatuses,
  GuideRefundStatus,
  normalizeProviderStatusCode,
  ShipmentStatus
} from '@platform/core/domain'
import { CarrierRegistry } from '@platform/plugins/runtime'
import {
  type CarrierContext,
  type CarrierPlugin,
  type CreateShipmentParams,
  PickupBatchOutcomes,
  ShipmentCreationModes
} from '@platform/plugins/sdk'

// What differs per plugin: captured from the real carrier, with personal data replaced. The suite itself
// knows no carrier (TDD_17 §4.1, TDD_10 §9).
export interface CarrierTestFixtures {
  // Dummy credentials the plugin accepts
  context: CarrierContext
  // A valid create for an order; the suite derives the other shipments of a batch from it
  createParams: CreateShipmentParams
  // The date and window of a pickup-bound batch
  pickupWindow?: { date: string; from: string; to: string }
  // Required when the plugin declares WEBHOOK_STATUS
  webhook?: {
    // A valid, signed event
    rawBody: string
    headers: Record<string, string>
    body: unknown
    secret: string
    invalidHeaders: Record<string, string>
    // A valid payload that carries no events
    emptyBody: unknown
  }
  // Every value that must never come back out of the plugin: tokens, passwords, signing keys
  secrets: readonly string[]
}

// The timestamps of the SDK are ISO 8601, not whatever Date can parse
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

const logger = new Proxy({}, { get: () => jest.fn() }) as unknown as PinoLogger

// The carrier plugins are held to this suite: a change that breaks it breaks every carrier. A case that needs a
// capability the plugin does not declare is skipped (and shows as skipped, not as passed), so the suite never forces
// a method a carrier does not have.
export function testCarrierPluginContract(
  createPlugin: () => CarrierPlugin,
  fixtures: CarrierTestFixtures
): void {
  // Read once to decide which cases run; each case gets a plugin of its own, so no state leaks between them
  const declared = createPlugin()
  const declares = (capability: CarrierPlugin['capabilities'][number]): boolean =>
    declared.capabilities.includes(capability)
  const when = (condition: boolean): typeof it => (condition ? it : it.skip)
  const standalone = declared.shipmentCreation === ShipmentCreationModes.STANDALONE
  const pickupBound = declared.shipmentCreation === ShipmentCreationModes.PICKUP_BOUND
  const internal = declared.shipmentCreation === ShipmentCreationModes.INTERNAL
  const webhook = declares(CarrierCapability.WEBHOOK_STATUS) ? fixtures.webhook : undefined

  describe('carrier plugin contract', () => {
    let plugin: CarrierPlugin
    const has = (capability: CarrierPlugin['capabilities'][number]): boolean =>
      plugin.capabilities.includes(capability)
    // Whether the plugin has the method, without taking the method out of the object
    const implemented = (name: string): boolean => typeof Reflect.get(plugin, name) === 'function'
    // The bytes of a label are text too: a key printed into a PDF is a leak
    const leaks = (value: unknown): string[] => {
      const text =
        JSON.stringify(value, (_key, item: unknown) =>
          item instanceof Uint8Array ? new TextDecoder().decode(item) : item
        ) ?? ''
      return fixtures.secrets.filter(secret => text.includes(secret))
    }

    beforeEach(() => {
      plugin = createPlugin()
    })

    describe('identity and registration', () => {
      it('passes the fail-fast checks of the registry', () => {
        const registry = new CarrierRegistry(logger)
        registry.register(plugin)
        expect(registry.get(plugin.id)).toBe(plugin)
      })

      it('declares exactly one creation mode and the capability that goes with it', () => {
        const byMode = {
          [ShipmentCreationModes.STANDALONE]: CarrierCapability.CREATE_SHIPMENT,
          [ShipmentCreationModes.PICKUP_BOUND]: CarrierCapability.PICKUP_BOUND_GUIDES,
          [ShipmentCreationModes.INTERNAL]: CarrierCapability.INTERNAL_GUIDE
        }
        expect(plugin.capabilities).toContain(byMode[plugin.shipmentCreation])
        const others = Object.values(byMode).filter(c => c !== byMode[plugin.shipmentCreation])
        for (const other of others) expect(plugin.capabilities).not.toContain(other)
      })

      it('lists each capability once', () => {
        expect(new Set(plugin.capabilities).size).toBe(plugin.capabilities.length)
      })

      when(pickupBound)('declares a batch size and a way to recover a pickup', () => {
        expect(Number.isInteger(plugin.maxBatchSize)).toBe(true)
        expect(plugin.maxBatchSize).toBeGreaterThan(0)
        // "Check with the carrier" recovers the guides of an unknown outcome through the pickup
        expect(implemented('fetchPickup')).toBe(true)
      })

      when(internal)(
        'does not claim an idempotent create for a guide the core makes itself',
        () => {
          expect(plugin.capabilities).not.toContain(CarrierCapability.IDEMPOTENT_CREATE)
        }
      )

      it('has the webhook fixtures when it declares a webhook', () => {
        if (declares(CarrierCapability.WEBHOOK_STATUS)) expect(fixtures.webhook).toBeDefined()
      })
    })

    describe('catalogs', () => {
      it('has service codes that are unique, non-empty and labelled', () => {
        const services = plugin.serviceCatalog()
        expect(new Set(services.map(s => s.code)).size).toBe(services.length)
        for (const service of services) {
          expect(service.code.trim()).not.toBe('')
          expect(service.label.trim()).not.toBe('')
        }
        expect(services.filter(s => s.defaultForNextDay === true).length).toBeLessThanOrEqual(1)
      })

      it('has status codes stored the way a mapping looks them up', () => {
        const statuses = plugin.statusCatalog()
        const codes = statuses.map(s => s.code)
        expect(new Set(codes).size).toBe(codes.length)
        for (const status of statuses) {
          // The code is normalized, so a seeded mapping and an arriving code meet (TDD_17 §4.17)
          expect(status.code).toBe(normalizeProviderStatusCode(status.code))
          expect(status.code).not.toBe('')
          expect(status.label.trim()).not.toBe('')
          // null is an informational code; a target is only a status a carrier can report
          if (status.defaultStatus !== null) {
            expect(CarrierReportableStatuses).toContain(status.defaultStatus)
          }
        }
      })

      it('reads the same twice', () => {
        expect(plugin.serviceCatalog()).toEqual(plugin.serviceCatalog())
        expect(plugin.statusCatalog()).toEqual(plugin.statusCatalog())
      })
    })

    describe('connection', () => {
      it('connects with a display name and answers a health check', async () => {
        const connected = await plugin.connect({
          storeId: fixtures.context.storeId,
          credentials: fixtures.context.credentials
        })
        expect(connected.displayName.trim()).not.toBe('')
        const health = await plugin.healthCheck(fixtures.context)
        expect(typeof health.healthy).toBe('boolean')
        expect(health.checkedAt).toMatch(ISO_8601)
      })

      it('does not return a credential in the health check', async () => {
        expect(leaks(await plugin.healthCheck(fixtures.context))).toEqual([])
      })

      it('disconnects without throwing', async () => {
        await expect(plugin.disconnect(fixtures.context)).resolves.toBeUndefined()
      })
    })

    describe('creating a shipment', () => {
      when(standalone)('makes a guide with a label and returns no credential', async () => {
        const params = structuredClone(fixtures.createParams)
        const result = await plugin.createShipment?.(fixtures.context, params)
        expect(result?.guideNumber.trim()).toBeTruthy()
        if (result?.label) {
          expect(result.label.format).toBe(params.labelFormat)
          expect(result.label.data.byteLength).toBeGreaterThan(0)
        }
        if (result?.cost) {
          expect(Number.isInteger(result.cost.amountCents)).toBe(true)
          expect(result.cost.amountCents).toBeGreaterThanOrEqual(0)
        }
        expect(leaks(result)).toEqual([])
        // What the core sent is the core's: the plugin never edits it
        expect(params).toEqual(fixtures.createParams)
      })

      when(standalone && declares(CarrierCapability.IDEMPOTENT_CREATE))(
        'keeps the idempotent create it claims: the same key never makes a second guide',
        async () => {
          const first = await plugin.createShipment?.(fixtures.context, fixtures.createParams)
          const second = await plugin.createShipment?.(fixtures.context, fixtures.createParams)
          expect(second?.guideNumber).toBe(first?.guideNumber)
        }
      )

      // The batch is as big as the carrier takes, up to two shipments, and the pickup counts what the batch holds
      const batchOf = (): {
        shipments: CreateShipmentParams[]
        pickup: { window: { date: string; from: string; to: string }; packageCount: number }
        idempotencyKey: string
      } => {
        const size = Math.min(2, declared.maxBatchSize ?? 2)
        const shipments = Array.from({ length: size }, (_, index) => ({
          ...structuredClone(fixtures.createParams),
          reference: `${fixtures.createParams.reference}-${index + 1}`,
          idempotencyKey: `${fixtures.createParams.idempotencyKey}-${index + 1}`
        }))
        return {
          shipments,
          pickup: {
            window: fixtures.pickupWindow ?? { date: '2026-12-01', from: '09:00', to: '12:00' },
            packageCount: shipments.reduce((total, shipment) => total + shipment.packageCount, 0)
          },
          idempotencyKey: `batch-${fixtures.createParams.idempotencyKey}`
        }
      }

      when(pickupBound)(
        'makes the guides of a batch in order, with a refusal that stays with its shipment',
        async () => {
          const batchParams = batchOf()
          const batch = await plugin.createShipmentsWithPickup?.(fixtures.context, batchParams)
          expect(batch?.pickupRef.trim()).toBeTruthy()
          // One entry per shipment, in the order of the batch
          expect(batch?.shipments).toHaveLength(batchParams.shipments.length)
          for (const entry of batch?.shipments ?? []) {
            expect(Object.values(PickupBatchOutcomes)).toContain(entry.outcome)
            if (entry.outcome === PickupBatchOutcomes.CREATED) {
              expect(entry.shipment.guideNumber.trim()).toBeTruthy()
            } else {
              expect(entry.message.trim()).not.toBe('')
            }
          }
          expect(leaks(batch)).toEqual([])

          // What the carrier made can be found again by the reference, to complete an unknown outcome
          const found = await plugin.fetchPickup?.(fixtures.context, {
            pickupRef: batch?.pickupRef ?? ''
          })
          const made = (batch?.shipments ?? []).flatMap((entry, index) =>
            entry.outcome === PickupBatchOutcomes.CREATED
              ? [
                  {
                    reference: batchParams.shipments[index]?.reference,
                    guide: entry.shipment.guideNumber
                  }
                ]
              : []
          )
          for (const { reference, guide } of made) {
            expect(found?.shipments.find(s => s.reference === reference)?.guideNumber).toBe(guide)
          }
        }
      )

      when(pickupBound && declares(CarrierCapability.IDEMPOTENT_CREATE))(
        'keeps the idempotent create it claims for a batch: the same keys never make second guides',
        async () => {
          const batchParams = batchOf()
          const first = await plugin.createShipmentsWithPickup?.(fixtures.context, batchParams)
          const second = await plugin.createShipmentsWithPickup?.(fixtures.context, batchParams)
          const guides = (batch: typeof first): (string | null)[] =>
            (batch?.shipments ?? []).map(entry =>
              entry.outcome === PickupBatchOutcomes.CREATED ? entry.shipment.guideNumber : null
            )
          expect(guides(second)).toEqual(guides(first))
        }
      )

      when(internal)('makes no guide through a creation method', () => {
        expect(implemented('createShipment')).toBe(false)
        expect(implemented('createShipmentsWithPickup')).toBe(false)
      })
    })

    describe('cancelling a shipment', () => {
      when(standalone && declares(CarrierCapability.CANCEL_SHIPMENT))(
        'voids a guide and reports the refund as the carrier does',
        async () => {
          const made = await plugin.createShipment?.(fixtures.context, fixtures.createParams)
          const result = await plugin.cancelShipment?.(fixtures.context, {
            reference: fixtures.createParams.reference,
            guideNumber: made?.guideNumber ?? '',
            ...(made?.providerShipmentId === undefined
              ? {}
              : { providerShipmentId: made.providerShipmentId }),
            idempotencyKey: `cancel-${fixtures.createParams.idempotencyKey}`
          })
          expect([GuideRefundStatus.PENDING, GuideRefundStatus.CONFIRMED]).toContain(
            result?.refundStatus
          )
        }
      )

      it('has a cancel method exactly when it declares the capability', () => {
        expect(implemented('cancelShipment')).toBe(has(CarrierCapability.CANCEL_SHIPMENT))
      })
    })

    describe('status', () => {
      it('has the methods of the status flow it declares, and only those', () => {
        expect(implemented('fetchStatus')).toBe(has(CarrierCapability.FETCH_STATUS))
        expect(implemented('handleWebhook')).toBe(has(CarrierCapability.WEBHOOK_STATUS))
        expect(implemented('validateWebhookSignature')).toBe(has(CarrierCapability.WEBHOOK_STATUS))
      })

      when(webhook !== undefined)('rejects a bad signature and accepts a good one', () => {
        if (!webhook || !plugin.validateWebhookSignature) throw new Error('No webhook to check')
        expect(
          plugin.validateWebhookSignature(webhook.rawBody, webhook.invalidHeaders, webhook.secret)
        ).toBe(false)
        expect(
          plugin.validateWebhookSignature(webhook.rawBody, webhook.headers, webhook.secret)
        ).toBe(true)
        // The signature belongs to the secret of the connection
        expect(
          plugin.validateWebhookSignature(webhook.rawBody, webhook.headers, `${webhook.secret}x`)
        ).toBe(false)
      })

      when(webhook !== undefined)('normalizes a webhook into events and is pure', async () => {
        if (!webhook || !plugin.handleWebhook) throw new Error('No webhook to check')
        const payload = structuredClone(webhook.body)
        const first = await plugin.handleWebhook(payload)
        const second = await plugin.handleWebhook(payload)
        expect(first.length).toBeGreaterThan(0)
        // The same payload gives the same events and is left as it was: nothing is fetched or remembered
        expect(second).toEqual(first)
        expect(payload).toEqual(webhook.body)
        for (const event of first) {
          expect(event.occurredAt).toMatch(ISO_8601)
          expect(event.rawStatus.trim()).not.toBe('')
          expect(event.guideNumber ?? event.providerShipmentId ?? event.reference).toBeTruthy()
          if (event.status !== null) {
            expect(Object.values(ShipmentStatus)).toContain(event.status)
          }
        }
        expect(leaks(first)).toEqual([])
      })

      when(webhook !== undefined)(
        'maps a code of its catalog to the status the catalog says',
        async () => {
          if (!webhook || !plugin.handleWebhook) throw new Error('No webhook to check')
          const catalog = new Map(
            plugin.statusCatalog().map(entry => [entry.code, entry.defaultStatus])
          )
          for (const event of await plugin.handleWebhook(structuredClone(webhook.body))) {
            const code = normalizeProviderStatusCode(event.rawStatus)
            if (catalog.has(code)) expect(event.status).toBe(catalog.get(code))
          }
        }
      )

      when(webhook !== undefined)('answers a payload with no events with no events', async () => {
        if (!webhook || !plugin.handleWebhook) throw new Error('No webhook to check')
        await expect(plugin.handleWebhook(webhook.emptyBody)).resolves.toEqual([])
      })
    })

    describe('pickups', () => {
      it('has the pickup methods it declares, and only those', () => {
        expect(implemented('requestPickup')).toBe(has(CarrierCapability.PICKUP_REQUEST))
        expect(implemented('modifyPickup')).toBe(has(CarrierCapability.PICKUP_MODIFY))
        expect(implemented('cancelPickup')).toBe(has(CarrierCapability.PICKUP_CANCEL))
      })
    })
  })
}
