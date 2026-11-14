import type {
  CarrierCapabilityType,
  CarrierIdType,
  CarrierWebhookTrustType
} from '@platform/core/domain'

import type { LabelInput, LabelLayout } from './carrier-label'
import type {
  CancelPickupParams,
  CancelShipmentParams,
  CancelShipmentResult,
  CarrierConnectInput,
  CarrierConnectResult,
  CarrierContext,
  CarrierFeeSettings,
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
import type { ConnectField } from './channel-types'
import type { PluginTypes } from './plugin-types'

// How guides come into being ('internal' is `CarrierCapability.INTERNAL_GUIDE`: the core makes the guide).
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
  // What the connect form asks for, the declaration the channel plugins have (checked by the registry when it is present). A
  // carrier that asks for nothing, because the core draws its form, leaves it out
  readonly connectFields?: readonly ConnectField[]
  // The commission and the rates per service the owner can agree with the carrier (checked by the registry when present). A carrier
  // that takes neither leaves it out and its remittances are held to the cost the carrier reports, if any
  readonly feeSettings?: CarrierFeeSettings

  serviceCatalog(): readonly CarrierServiceDescriptor[]
  statusCatalog(): readonly CarrierStatusDescriptor[]

  connect(input: CarrierConnectInput): Promise<CarrierConnectResult>
  disconnect(ctx: CarrierContext): Promise<void>
  healthCheck(ctx: CarrierContext): Promise<CarrierHealth>

  readonly shipmentCreation: ShipmentCreationMode
  // pickup_bound: the most shipments one call accepts
  readonly maxBatchSize?: number
  // standalone: the most guides the platform asks for at the same time on one connection when it makes many (a bulk run), so the
  // carrier's rate limit is respected. Without it the platform asks for three at a time, and never for more than ten whatever is declared.
  readonly maxConcurrency?: number
  createShipment?(ctx: CarrierContext, params: CreateShipmentParams): Promise<CreateShipmentResult>
  createShipmentsWithPickup?(
    ctx: CarrierContext,
    params: CreatePickupBatchParams
  ): Promise<PickupBatchResult>
  // internal (INTERNAL_GUIDE): the core makes the guide and asks the plugin where each thing goes on the label.
  // Pure: the same input gives the same layout, and nothing is fetched or stored
  buildLabelLayout?(input: LabelInput): LabelLayout
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
  // What `validateWebhookSignature` proves. Absent means `signed`. A carrier that sends a shared secret in a header declares
  // `shared_secret`: the job then asks `fetchStatus` before it applies DELIVERED or RETURNED (TDD_17 §4.9), so such a plugin
  // must also declare FETCH_STATUS
  readonly webhookTrust?: CarrierWebhookTrustType
}
