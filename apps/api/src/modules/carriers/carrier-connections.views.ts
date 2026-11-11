import {
  CarrierCapability,
  type CarrierCapabilityType,
  type CarrierHealthReason,
  PickupStatus,
  ShipmentStatus
} from '@platform/core/domain'

// What a client reads of a connection (TDD_17 §6). Nothing secret is in it: the credentials and the webhook secret are
// ciphertext in the database and only `hasCredentials` and `hasWebhookSecret` say they exist.
export interface CarrierServiceView {
  code: string
  label: string
  active: boolean
}

export interface CarrierConnectionView {
  id: string
  carrierId: string
  // The carrier's name in the language of the store
  carrierName: string
  displayName: string
  status: string
  hasCredentials: boolean
  hasWebhookSecret: boolean
  // The address a carrier that pushes statuses is told to call, when the plugin declares it
  webhookUrl: string | null
  capabilities: readonly CarrierCapabilityType[]
  isDefault: boolean
  defaultServiceCode: string | null
  defaultShippingPayer: string
  labelFormat: string
  // The settings the plugin gave back at connect: a `local` courier's phone and notes
  contact: Record<string, unknown> | null
  // `local` only: the prefix of its guides
  guidePrefix: string | null
  services: CarrierServiceView[]
  pickupEnabled: boolean
  pickupDays: number[]
  pickupCutoffTime: string | null
  autoPickup: boolean
  autoPickupTime: string | null
  pickupReminderMinutes: number
  pollIntervalMinutes: number | null
  maxDeliveryAttempts: number
  defaultShippingFeeCents: number | null
  minShippingFeeCents: number | null
  maxShippingFeeCents: number | null
  remittanceDeductsFee: boolean
  // Shipments in flight and pickups waiting: what a disconnect leaves without a carrier to ask
  openShipments: number
  openPickups: number
  lastHealthyAt: string | null
  lastError: CarrierHealthReason | null
  createdAt: string
  updatedAt: string
}

// What the connect call adds to the view, once: the secret the carrier is told to sign its webhook with. It is made by the
// platform, kept encrypted, and never returned again.
export interface ConnectedCarrierView extends CarrierConnectionView {
  webhookSecret: string | null
}

export interface CarrierTestResult {
  healthy: boolean
  checkedAt: string
  reason: CarrierHealthReason | null
}

export interface CarrierRegistryEntry {
  id: string
  name: string
  version: string
  capabilities: readonly CarrierCapabilityType[]
  shipmentCreation: string
  maxBatchSize: number | null
  // Whether the carrier needs credentials of an account (false for a courier the platform makes the guide for)
  hasCredentials: boolean
  services: { code: string; label: string }[]
}

// Shipments the carrier still has to deliver or answer for, and the pickups still waiting: the same on the view of a
// connection and on the catalog entry that uninstalling warns with
export const OPEN_SHIPMENT_FILTER: { status: { notIn: string[] } } = {
  status: {
    notIn: [
      ShipmentStatus.DELIVERED,
      ShipmentStatus.RETURNED,
      ShipmentStatus.CANCELLED,
      ShipmentStatus.FAILED
    ]
  }
}

export const OPEN_PICKUP_FILTER: { status: { in: string[] } } = {
  status: {
    in: [
      PickupStatus.PENDING,
      PickupStatus.REQUIRES_REVIEW,
      PickupStatus.REQUESTED,
      PickupStatus.MANUAL_REQUIRED
    ]
  }
}

export const CONNECTION_SELECT = {
  id: true,
  carrierId: true,
  displayName: true,
  status: true,
  credentials: true,
  webhookSecret: true,
  defaultServiceCode: true,
  defaultShippingPayer: true,
  labelFormat: true,
  contact: true,
  pickupEnabled: true,
  pickupDays: true,
  pickupCutoffTime: true,
  autoPickup: true,
  autoPickupTime: true,
  pickupReminderMinutes: true,
  pollIntervalMinutes: true,
  maxDeliveryAttempts: true,
  defaultShippingFeeCents: true,
  minShippingFeeCents: true,
  maxShippingFeeCents: true,
  remittanceDeductsFee: true,
  lastHealthyAt: true,
  lastError: true,
  createdAt: true,
  updatedAt: true,
  services: { select: { code: true, label: true, active: true }, orderBy: { code: 'asc' } },
  guideSequence: { select: { prefix: true } },
  _count: {
    select: {
      shipments: { where: OPEN_SHIPMENT_FILTER },
      pickups: { where: OPEN_PICKUP_FILTER }
    }
  }
} as const

// The row the select above reads
export interface ConnectionRow {
  id: string
  carrierId: string
  displayName: string
  status: string
  credentials: Uint8Array | null
  webhookSecret: Uint8Array | null
  defaultServiceCode: string | null
  defaultShippingPayer: string
  labelFormat: string
  contact: unknown
  pickupEnabled: boolean
  pickupDays: number[]
  pickupCutoffTime: string | null
  autoPickup: boolean
  autoPickupTime: string | null
  pickupReminderMinutes: number
  pollIntervalMinutes: number | null
  maxDeliveryAttempts: number
  defaultShippingFeeCents: number | null
  minShippingFeeCents: number | null
  maxShippingFeeCents: number | null
  remittanceDeductsFee: boolean
  lastHealthyAt: Date | null
  lastError: string | null
  createdAt: Date
  updatedAt: Date
  services: { code: string; label: string; active: boolean }[]
  guideSequence: { prefix: string } | null
  _count: { shipments: number; pickups: number }
}

export function hasCapability(
  capabilities: readonly CarrierCapabilityType[],
  capability: CarrierCapabilityType
): boolean {
  return capabilities.includes(capability)
}

export const WEBHOOK_CAPABILITY = CarrierCapability.WEBHOOK_STATUS
