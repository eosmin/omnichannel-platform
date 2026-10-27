import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import {
  CarrierCapability,
  type CarrierCapabilityType,
  CarrierId,
  type CarrierIdType
} from '@platform/core/domain'
import {
  type CarrierPlugin,
  PluginTypes,
  ShipmentCreationModes,
  type ShipmentCreationMode
} from '@platform/plugins/sdk'

import {
  assertMethodsForCapabilities,
  contractViolation,
  pluginAlreadyRegistered,
  pluginNotFound,
  printable,
  snapshotCapabilities
} from './contract-rules'

const METHODS_BY_CAPABILITY = [
  [CarrierCapability.CANCEL_SHIPMENT, 'cancelShipment'],
  [CarrierCapability.FETCH_STATUS, 'fetchStatus'],
  [CarrierCapability.WEBHOOK_STATUS, 'handleWebhook'],
  [CarrierCapability.WEBHOOK_STATUS, 'validateWebhookSignature'],
  [CarrierCapability.PICKUP_REQUEST, 'requestPickup'],
  [CarrierCapability.PICKUP_MODIFY, 'modifyPickup'],
  [CarrierCapability.PICKUP_CANCEL, 'cancelPickup'],
  [CarrierCapability.REQUIRES_LOCATION_IDS, 'lookupLocations']
] as const

// A plugin declares exactly one way of making guides and implements the method that goes with it:
// the capability, the mode and the method must agree
const CREATION: Record<
  ShipmentCreationMode,
  {
    capability: (typeof CarrierCapability)[keyof typeof CarrierCapability]
    method: 'createShipment' | 'createShipmentsWithPickup' | null
  }
> = {
  [ShipmentCreationModes.STANDALONE]: {
    capability: CarrierCapability.CREATE_SHIPMENT,
    method: 'createShipment'
  },
  [ShipmentCreationModes.PICKUP_BOUND]: {
    capability: CarrierCapability.PICKUP_BOUND_GUIDES,
    method: 'createShipmentsWithPickup'
  },
  [ShipmentCreationModes.INTERNAL]: {
    capability: CarrierCapability.INTERNAL_GUIDE,
    method: null
  }
}

// What every carrier does, whatever it declares
const REQUIRED_METHODS = [
  'connect',
  'disconnect',
  'healthCheck',
  'serviceCatalog',
  'statusCatalog'
] as const

const CARRIER_IDS: ReadonlySet<string> = new Set(Object.values(CarrierId))

// The carrier plugins of this process, keyed by the id of the carrier
@Injectable()
export class CarrierRegistry {
  // The capabilities are a copy taken when the carrier passed its contract
  private readonly plugins = new Map<
    CarrierIdType,
    { plugin: CarrierPlugin; capabilities: ReadonlySet<CarrierCapabilityType> }
  >()

  constructor(private readonly logger: PinoLogger) {
    // Not @InjectPinoLogger(name): see ProcessorSupport
    this.logger.setContext(CarrierRegistry.name)
  }

  register(plugin: CarrierPlugin): void {
    // Read once, as the channel registry does
    const id = plugin.id
    const capabilities = snapshotCapabilities(plugin.capabilities)
    this.validateContract(plugin, id, capabilities)
    if (this.plugins.has(id)) throw pluginAlreadyRegistered('Carrier', id)
    this.plugins.set(id, { plugin, capabilities: new Set(capabilities) })
    this.logger.info({ pluginId: id, version: plugin.version }, 'carrier registered')
  }

  get(carrierId: string): CarrierPlugin {
    const plugin = this.find(carrierId)
    if (!plugin) throw pluginNotFound('Carrier', carrierId)
    return plugin
  }

  find(carrierId: string): CarrierPlugin | undefined {
    return CARRIER_IDS.has(carrierId)
      ? this.plugins.get(carrierId as CarrierIdType)?.plugin
      : undefined
  }

  list(): CarrierPlugin[] {
    return [...this.plugins.values()].map(entry => entry.plugin)
  }

  hasCapability(carrierId: string, capability: CarrierPlugin['capabilities'][number]): boolean {
    return CARRIER_IDS.has(carrierId)
      ? (this.plugins.get(carrierId as CarrierIdType)?.capabilities.has(capability) ?? false)
      : false
  }

  private validateContract(
    plugin: CarrierPlugin,
    id: string,
    capabilities: readonly CarrierCapabilityType[]
  ): void {
    if (plugin.type !== PluginTypes.CARRIER) {
      throw contractViolation(`Carrier ${printable(id)} is not a carrier plugin`)
    }
    for (const method of REQUIRED_METHODS) {
      if (typeof plugin[method] !== 'function') {
        throw contractViolation(`Carrier ${printable(id)} does not implement ${method}`)
      }
    }
    if (!CARRIER_IDS.has(id)) {
      throw contractViolation(`Carrier id ${printable(id)} is not a known CarrierId`)
    }
    assertMethodsForCapabilities(id, capabilities, plugin, METHODS_BY_CAPABILITY)
    if (
      plugin.maxBatchSize !== undefined &&
      !(Number.isInteger(plugin.maxBatchSize) && plugin.maxBatchSize > 0)
    ) {
      throw contractViolation(`Carrier ${printable(id)} has an invalid maxBatchSize`)
    }

    if (!Object.hasOwn(CREATION, plugin.shipmentCreation)) {
      throw contractViolation(`Carrier ${printable(id)} has an unknown creation mode`)
    }
    const mode = CREATION[plugin.shipmentCreation]
    if (!capabilities.includes(mode.capability)) {
      throw contractViolation(
        `Carrier ${printable(id)} creates guides as ${plugin.shipmentCreation} but does not declare ${mode.capability}`
      )
    }
    // The other creation capabilities would be promises with no method behind them
    for (const other of Object.values(CREATION)) {
      if (other !== mode && capabilities.includes(other.capability)) {
        throw contractViolation(
          `Carrier ${printable(id)} creates guides as ${plugin.shipmentCreation} but declares ${other.capability}`
        )
      }
    }
    for (const method of ['createShipment', 'createShipmentsWithPickup'] as const) {
      const implemented = typeof plugin[method] === 'function'
      if (implemented !== (method === mode.method)) {
        throw contractViolation(
          `Carrier ${printable(id)} creates guides as ${plugin.shipmentCreation}, so it ${
            method === mode.method ? 'must' : 'must not'
          } implement ${method}`
        )
      }
    }
  }
}
