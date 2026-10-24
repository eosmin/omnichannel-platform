// How much friction a destructive action gets (TDD_09 §11.1). CRITICAL always asks for a typed
// confirmation phrase; HIGH is configurable per store and on by default; MODERATE is configurable
// per user; LOW only offers an undo toast. Deleting an organization is not an action in the MVP:
// the single organization is never deleted.
export const DestructiveActionTierLevels = {
  CRITICAL: 'critical',
  HIGH: 'high',
  MODERATE: 'moderate',
  LOW: 'low'
} as const
export type DestructiveActionTier =
  (typeof DestructiveActionTierLevels)[keyof typeof DestructiveActionTierLevels]

const { CRITICAL, HIGH, MODERATE, LOW } = DestructiveActionTierLevels

export const DestructiveActionTiers = {
  // Critical
  DELETE_STORE: CRITICAL,
  REVOKE_ALL_PLUGIN_ACCESS: CRITICAL,
  REVOKE_API_KEY: CRITICAL,

  // High
  DELETE_CUSTOMER: HIGH,
  CANCEL_ORDER_WITH_SHIPMENT: HIGH, // Also voids the guide (TDD_17 §4.8)
  DISCONNECT_CHANNEL: HIGH,
  REMOVE_TEAM_MEMBER: HIGH,
  DELETE_ROUTING_RULE: HIGH,
  CANCEL_IN_TRANSIT_TRANSFER: HIGH, // TDD_16
  APPLY_STOCK_COUNT: HIGH, // TDD_16
  DISCONNECT_CARRIER_WITH_OPEN_SHIPMENTS: HIGH, // TDD_17
  MARK_GUIDE_VOIDED_BY_HAND: HIGH, // TDD_17
  VOID_CONFIRMED_REMITTANCE: HIGH, // TDD_17

  // Moderate
  ARCHIVE_CONVERSATION: MODERATE,
  REASSIGN_ASSIGNED_CONVERSATION: MODERATE,
  EDIT_CUSTOMER_IDENTITY: MODERATE,
  REQUEST_PICKUP_AFTER_CUTOFF: MODERATE, // TDD_17

  // Low
  ADD_OR_REMOVE_TAG: LOW,
  SEND_MESSAGE: LOW,
  CREATE_ORDER: LOW,
  CHANGE_CONVERSATION_STATUS: LOW
} as const satisfies Record<string, DestructiveActionTier>
export type DestructiveAction = keyof typeof DestructiveActionTiers
