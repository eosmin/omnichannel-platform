import { RoleNames } from './auth/permissions'

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
  DELETE_PLUGIN: CRITICAL, // Settings → Plugins; the plugin the organization registered leaves the catalog, with the rows of its revoked installations
  REVOKE_API_KEY: CRITICAL,
  DELETE_CONVERSATION: CRITICAL, // The conversation, its messages and its files are gone for good (TDD_05 §10.4)

  // High
  DELETE_CUSTOMER: HIGH,
  CANCEL_ORDER_WITH_SHIPMENT: HIGH, // Also voids the guide (TDD_17 §4.8)
  DISCONNECT_CHANNEL: HIGH,
  REMOVE_TEAM_MEMBER: HIGH,
  SUSPEND_TEAM_MEMBER: HIGH, // Settings → Team; cuts the person's access at once and returns their open conversations to the queue
  DELETE_CUSTOM_ROLE: HIGH, // Settings → Team; the api refuses a role that members or invitations hold
  DELETE_ROUTING_RULE: HIGH,
  DELETE_TAG: HIGH, // Settings → Tags; takes the tag off every customer and conversation that has it
  CANCEL_IN_TRANSIT_TRANSFER: HIGH, // TDD_16
  APPLY_STOCK_COUNT: HIGH, // TDD_16
  CANCEL_STOCK_COUNT: HIGH, // TDD_16; the quantities counted so far are thrown away and the sheet cannot be opened again
  DISCONNECT_CARRIER_WITH_OPEN_SHIPMENTS: HIGH, // TDD_17
  MARK_GUIDE_VOIDED_BY_HAND: HIGH, // TDD_17
  ROTATE_CARRIER_WEBHOOK_SECRET: HIGH, // Settings → Carriers; the old secret stops working at once, so the carrier's panel must be updated right after
  VOID_CONFIRMED_REMITTANCE: HIGH, // TDD_17
  POST_MANUAL_ENTRY: HIGH, // TDD_18 §3; a journal entry cannot be edited or erased afterwards, only reversed by another
  REVERSE_ENTRY: HIGH, // TDD_18 §3; an entry is reversed at most once, and the reversal stays in the journal for good
  CLOSE_FISCAL_PERIOD: HIGH, // TDD_18 §5.1; the month is frozen: no entry is accepted in it and its report does not move
  REOPEN_FISCAL_PERIOD: HIGH, // TDD_18 §5.3; only the latest closed month, with the reason typed; the books of that month can change again
  VOID_SUPPLIER_PAYMENT: HIGH, // TDD_18 §4.2 E11; voiding a payment to a supplier writes a reversing entry that stays in the journal for good and makes the bill owed again, and a voided one is not voided again
  VOID_FISCAL_DOCUMENT: HIGH, // TDD_18 §8.3; the invalidation of an accepted fiscal document with the authority: it cannot be taken back and is audited
  CONFIRM_FISCAL_ISSUER_CHANGE: HIGH, // TDD_18 §8.3; a person states that a document is not at the issuer it was made with, so it is sent to the new one: if it was there, the sale ends up with two documents
  VOID_FINANCE_TRANSACTION: HIGH, // TDD_18 §4.3; voiding an expense, an income or a transfer writes a reversing entry that stays in the journal for good, and a voided one is not voided again
  DELETE_WEBHOOK: HIGH, // Settings → Webhooks; the endpoint stops receiving events and its delivery log goes with it
  ROTATE_WEBHOOK_SECRET: HIGH, // Settings → Webhooks; the old secret stops working at once, so the receiver must be updated right after

  // Moderate
  ARCHIVE_CONVERSATION: MODERATE,
  REASSIGN_ASSIGNED_CONVERSATION: MODERATE,
  EDIT_CUSTOMER_IDENTITY: MODERATE,
  REQUEST_PICKUP_AFTER_CUTOFF: MODERATE, // TDD_17
  DELETE_SNIPPET: MODERATE, // Settings → Snippets; the api refuses one that the closing or away message uses
  REVOKE_INVITATION: MODERATE, // Settings → Team; the invitee's link stops working
  REACTIVATE_TEAM_MEMBER: MODERATE, // Settings → Team; gives a suspended person their access and role back

  // Low
  ADD_OR_REMOVE_TAG: LOW,
  SEND_MESSAGE: LOW,
  CREATE_ORDER: LOW,
  CHANGE_CONVERSATION_STATUS: LOW
} as const satisfies Record<string, DestructiveActionTier>
export type DestructiveAction = keyof typeof DestructiveActionTiers

// How a store asks before a destructive action of the HIGH and MODERATE tiers (TDD_09 §11.2). CRITICAL
// actions always ask for a typed phrase and LOW ones always offer an undo toast: neither is a setting.
// Here and not in `safety-settings.ts`, which holds the zod schema: the browser reads these two lists on every
// screen and must not load a schema for them.
export const ModerateRiskModes = {
  DIALOG: 'dialog',
  UNDO: 'undo',
  NONE: 'none'
} as const
export type ModerateRiskMode = (typeof ModerateRiskModes)[keyof typeof ModerateRiskModes]

// The system roles a confirmation can be limited to. A custom role is never listed and so always asks: the
// switches can only take the dialog away from the roles of the preset. (A custom role cannot be named like a
// system one: the api refuses the name, whatever its case.)
export const SafetyRoleNames = [RoleNames.AGENT, RoleNames.SUPERVISOR, RoleNames.ADMIN] as const
export type SafetyRoleName = (typeof SafetyRoleNames)[number]

// The HIGH actions that a store can stop asking about, with the key of `StoreSettings.safety` that holds the
// switch. Every other HIGH action always asks (a guide voided, a stock count applied, a secret rotated): the page
// has no switch for it.
export const SafetySwitchedActions = {
  DELETE_CUSTOMER: 'confirmDeleteCustomer',
  DISCONNECT_CHANNEL: 'confirmDisconnectChannel',
  REMOVE_TEAM_MEMBER: 'confirmRemoveMember'
} as const satisfies Partial<Record<keyof typeof DestructiveActionTiers, string>>
export type SafetySwitch = (typeof SafetySwitchedActions)[keyof typeof SafetySwitchedActions]
