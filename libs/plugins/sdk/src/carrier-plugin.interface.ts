import type { CarrierCapabilityType, CarrierIdType } from '@platform/core/domain'

import type {
  CancelPickupParams,
  CancelShipmentParams,
  CancelShipmentResult,
  CarrierConnectInput,
  CarrierConnectResult,
  CarrierContext,
  CarrierEvent,
  CarrierHealth,
  CarrierLabel,
  CarrierLocation,
  CarrierServiceDescriptor,
  CarrierStatusDescriptor,
  CreatePickupBatchParams,
  CreateShipmentParams,
  CreateShipmentResult,
  FetchLabelParams,
  LocationQuery,
  ModifyPickupParams,
  PickupBatchResult,
  PickupDetails,
  PickupParams,
  PickupRef,
  PickupResult,
  ShipmentRef
} from './carrier-types'
import type { PluginTypes } from './plugin-types'

// How guides come into being ('internal' is the `local` carrier: the core makes the guide).
export const ShipmentCreationModes = {
  STANDALONE: 'standalone',
  PICKUP_BOUND: 'pickup_bound',
  INTERNAL: 'internal'
} as const
export type ShipmentCreationMode =
  (typeof ShipmentCreationModes)[keyof typeof ShipmentCreationModes]

export interface CarrierPlugin {
  readonly id: CarrierIdType
  readonly name: string
  readonly version: string
  readonly author: string
  readonly type: typeof PluginTypes.CARRIER
  readonly capabilities: readonly CarrierCapabilityType[]

  serviceCatalog(): readonly CarrierServiceDescriptor[]
  statusCatalog(): readonly CarrierStatusDescriptor[]

  connect(input: CarrierConnectInput): Promise<CarrierConnectResult>
  disconnect(ctx: CarrierContext): Promise<void>
  healthCheck(ctx: CarrierContext): Promise<CarrierHealth>

  readonly shipmentCreation: ShipmentCreationMode
  // pickup_bound: the most shipments one call accepts
  readonly maxBatchSize?: number
  createShipment?(ctx: CarrierContext, params: CreateShipmentParams): Promise<CreateShipmentResult>
  createShipmentsWithPickup?(
    ctx: CarrierContext,
    params: CreatePickupBatchParams
  ): Promise<PickupBatchResult>
  // Recovers the guides of a pickup after an unknown outcome
  fetchPickup?(ctx: CarrierContext, ref: PickupRef): Promise<PickupDetails>
  cancelShipment?(ctx: CarrierContext, params: CancelShipmentParams): Promise<CancelShipmentResult>
  // For a carrier whose createShipment does not return the label
  fetchLabel?(ctx: CarrierContext, params: FetchLabelParams): Promise<CarrierLabel>
  fetchStatus?(ctx: CarrierContext, refs: ShipmentRef[]): Promise<CarrierEvent[]>
  lookupLocations?(ctx: CarrierContext, query: LocationQuery): Promise<CarrierLocation[]>

  requestPickup?(ctx: CarrierContext, params: PickupParams): Promise<PickupResult>
  modifyPickup?(ctx: CarrierContext, params: ModifyPickupParams): Promise<PickupResult>
  cancelPickup?(ctx: CarrierContext, params: CancelPickupParams): Promise<void>

  // Inbound status. Pure: normalizes and never fetches.
  validateWebhookSignature?(
    rawBody: string,
    headers: Record<string, string>,
    secret: string
  ): boolean
  handleWebhook?(payload: unknown): Promise<CarrierEvent[]>
}
