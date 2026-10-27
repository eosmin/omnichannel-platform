import type { PinoLogger } from 'nestjs-pino'

import { CarrierCapability, CarrierId } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { type CarrierPlugin, ShipmentCreationModes } from '@platform/plugins/sdk'

import { CarrierRegistry } from './carrier-registry'

const unused = (): never => {
  throw new Error('not used')
}

function carrier(overrides: Partial<CarrierPlugin> = {}): CarrierPlugin {
  return {
    id: CarrierId.FORZA,
    name: 'Forza',
    version: '1.0.0',
    author: 'suite',
    type: 'carrier',
    capabilities: [CarrierCapability.CREATE_SHIPMENT],
    serviceCatalog: () => [],
    statusCatalog: () => [],
    connect: unused,
    disconnect: unused,
    healthCheck: unused,
    shipmentCreation: ShipmentCreationModes.STANDALONE,
    createShipment: unused,
    ...overrides
  }
}

function build(): CarrierRegistry {
  const logger = { setContext: jest.fn(), info: jest.fn() }
  return new CarrierRegistry(logger as unknown as PinoLogger)
}

function codeOf(run: () => void): string | undefined {
  try {
    run()
  } catch (error) {
    return (error as { code?: string }).code
  }
  return undefined
}

describe('CarrierRegistry', () => {
  it('registers a standalone carrier and finds it', () => {
    const registry = build()
    const plugin = carrier()
    registry.register(plugin)
    expect(registry.get('forza')).toBe(plugin)
    expect(registry.list()).toEqual([plugin])
    expect(registry.hasCapability('forza', CarrierCapability.CREATE_SHIPMENT)).toBe(true)
    expect(registry.hasCapability('forza', CarrierCapability.COD)).toBe(false)
  })

  it('does not know an id that is not a carrier', () => {
    const registry = build()
    expect(registry.find('whatsapp')).toBeUndefined()
    expect(codeOf(() => registry.get('whatsapp'))).toBe(ErrorCodes.PLUGIN_NOT_FOUND)
  })

  it('refuses the same carrier twice', () => {
    const registry = build()
    registry.register(carrier())
    expect(codeOf(() => registry.register(carrier()))).toBe(ErrorCodes.PLUGIN_ALREADY_REGISTERED)
  })

  it.each([
    [CarrierCapability.CANCEL_SHIPMENT],
    [CarrierCapability.FETCH_STATUS],
    [CarrierCapability.WEBHOOK_STATUS],
    [CarrierCapability.PICKUP_REQUEST],
    [CarrierCapability.PICKUP_MODIFY],
    [CarrierCapability.PICKUP_CANCEL],
    [CarrierCapability.REQUIRES_LOCATION_IDS]
  ] as const)('rejects a carrier that declares %s and does not implement it', capability => {
    const plugin = carrier({ capabilities: [CarrierCapability.CREATE_SHIPMENT, capability] })
    expect(codeOf(() => build().register(plugin))).toBe(ErrorCodes.PLUGIN_CONTRACT_VIOLATION)
  })

  it('needs both methods of a webhook', () => {
    const plugin = carrier({
      capabilities: [CarrierCapability.CREATE_SHIPMENT, CarrierCapability.WEBHOOK_STATUS],
      handleWebhook: () => Promise.resolve([])
    })
    expect(codeOf(() => build().register(plugin))).toBe(ErrorCodes.PLUGIN_CONTRACT_VIOLATION)
  })

  it('accepts a capability whose method exists', () => {
    const plugin = carrier({
      capabilities: [CarrierCapability.CREATE_SHIPMENT, CarrierCapability.CANCEL_SHIPMENT],
      cancelShipment: unused
    })
    expect(() => build().register(plugin)).not.toThrow()
  })

  describe('how guides are created', () => {
    it('accepts a pickup-bound carrier', () => {
      const plugin = carrier({
        id: CarrierId.C807,
        shipmentCreation: ShipmentCreationModes.PICKUP_BOUND,
        capabilities: [CarrierCapability.PICKUP_BOUND_GUIDES],
        createShipment: undefined,
        createShipmentsWithPickup: unused,
        maxBatchSize: 50
      })
      expect(() => build().register(plugin)).not.toThrow()
    })

    it('accepts an internal carrier that implements neither method', () => {
      const plugin = carrier({
        id: CarrierId.LOCAL,
        shipmentCreation: ShipmentCreationModes.INTERNAL,
        capabilities: [CarrierCapability.INTERNAL_GUIDE],
        createShipment: undefined
      })
      expect(() => build().register(plugin)).not.toThrow()
    })

    it('rejects a standalone carrier without createShipment', () => {
      expect(codeOf(() => build().register(carrier({ createShipment: undefined })))).toBe(
        ErrorCodes.PLUGIN_CONTRACT_VIOLATION
      )
    })

    it('rejects a standalone carrier that also implements the pickup method', () => {
      expect(codeOf(() => build().register(carrier({ createShipmentsWithPickup: unused })))).toBe(
        ErrorCodes.PLUGIN_CONTRACT_VIOLATION
      )
    })

    it('rejects a pickup-bound carrier that implements createShipment', () => {
      const plugin = carrier({
        shipmentCreation: ShipmentCreationModes.PICKUP_BOUND,
        capabilities: [CarrierCapability.PICKUP_BOUND_GUIDES],
        createShipmentsWithPickup: unused
      })
      expect(codeOf(() => build().register(plugin))).toBe(ErrorCodes.PLUGIN_CONTRACT_VIOLATION)
    })

    it('rejects an internal carrier that implements a creation method', () => {
      const plugin = carrier({
        shipmentCreation: ShipmentCreationModes.INTERNAL,
        capabilities: [CarrierCapability.INTERNAL_GUIDE]
      })
      expect(codeOf(() => build().register(plugin))).toBe(ErrorCodes.PLUGIN_CONTRACT_VIOLATION)
    })

    it('rejects a mode whose capability is not declared', () => {
      expect(codeOf(() => build().register(carrier({ capabilities: [] })))).toBe(
        ErrorCodes.PLUGIN_CONTRACT_VIOLATION
      )
    })
  })

  it('rejects an id that is not a CarrierId, which could never be found again', () => {
    const plugin = carrier({ id: 'mystery' as CarrierPlugin['id'] })
    expect(codeOf(() => build().register(plugin))).toBe(ErrorCodes.PLUGIN_CONTRACT_VIOLATION)
  })

  it.each([0, -1, 1.5, Number.NaN])('rejects maxBatchSize %s', maxBatchSize => {
    const plugin = carrier({
      shipmentCreation: ShipmentCreationModes.PICKUP_BOUND,
      capabilities: [CarrierCapability.PICKUP_BOUND_GUIDES],
      createShipment: undefined,
      createShipmentsWithPickup: unused,
      maxBatchSize
    })
    expect(codeOf(() => build().register(plugin))).toBe(ErrorCodes.PLUGIN_CONTRACT_VIOLATION)
  })

  it.each([undefined, 'bulk'])('rejects the creation mode %j', mode => {
    const plugin = carrier({ shipmentCreation: mode as unknown as 'standalone' })
    expect(codeOf(() => build().register(plugin))).toBe(ErrorCodes.PLUGIN_CONTRACT_VIOLATION)
  })

  it('rejects a plugin without a capability list', () => {
    const plugin = { ...carrier(), capabilities: undefined } as unknown as CarrierPlugin
    expect(codeOf(() => build().register(plugin))).toBe(ErrorCodes.PLUGIN_CONTRACT_VIOLATION)
  })

  it.each(['connect', 'disconnect', 'healthCheck', 'serviceCatalog', 'statusCatalog'])(
    'rejects a carrier without %s, which every carrier needs',
    method => {
      const plugin = { ...carrier(), [method]: undefined }
      expect(codeOf(() => build().register(plugin))).toBe(ErrorCodes.PLUGIN_CONTRACT_VIOLATION)
    }
  )

  it('rejects a creation capability that is not the one of its mode', () => {
    const plugin = carrier({
      shipmentCreation: ShipmentCreationModes.PICKUP_BOUND,
      capabilities: [CarrierCapability.PICKUP_BOUND_GUIDES, CarrierCapability.CREATE_SHIPMENT],
      createShipment: undefined,
      createShipmentsWithPickup: unused
    })
    expect(codeOf(() => build().register(plugin))).toBe(ErrorCodes.PLUGIN_CONTRACT_VIOLATION)
  })

  it('answers about the capabilities it validated, not the ones the carrier has later', () => {
    const registry = build()
    const capabilities: CarrierPlugin['capabilities'][number][] = [
      CarrierCapability.CREATE_SHIPMENT
    ]
    registry.register(carrier({ capabilities }))
    capabilities.push(CarrierCapability.PICKUP_REQUEST)
    expect(registry.hasCapability('forza', CarrierCapability.PICKUP_REQUEST)).toBe(false)
  })

  it('does not print a hostile id: a symbol, a huge string or one with line breaks', () => {
    const hostile = [Symbol('x'), 'x'.repeat(100_000), 'a\nINJECTED log line']
    for (const id of hostile) {
      let message = ''
      try {
        build().register(carrier({ id: id as unknown as CarrierPlugin['id'] }))
      } catch (error) {
        expect((error as { code?: string }).code).toBe(ErrorCodes.PLUGIN_CONTRACT_VIOLATION)
        message = (error as Error).message
      }
      expect(message.length).toBeGreaterThan(0)
      expect(message.length).toBeLessThan(300)
      expect(message).not.toContain('\n')
    }
  })

  it('rejects a plugin of another type', () => {
    const plugin = { ...carrier(), type: 'channel' } as unknown as CarrierPlugin
    expect(codeOf(() => build().register(plugin))).toBe(ErrorCodes.PLUGIN_CONTRACT_VIOLATION)
  })
})
