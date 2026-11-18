import type { RlsExemption } from './lib/rls'

// The phases of the RLS step (docs/IMPLEMENTATION_PLAN.md, Step 7.1): 1 configuration, catalogs and audit, 2 conversations and
// customers, 3 orders, inventory and shipping, 4 finance and fiscal. Each phase is a migration that calls rls_apply_policy for its
// tables and deletes their lines from RLS_PENDING in the same change. The list only shrinks; it ends empty.
export const RLS_PHASES: readonly number[] = [1, 2, 3, 4]

const pending = (phase: number, reason: string): RlsExemption => ({
  kind: 'pending',
  phase,
  reason
})
const neverPolicy = (reason: string): RlsExemption => ({ kind: 'global', reason })

const BY_PARENT =
  'No store column: its policy goes through its parent (EXISTS on the parent, whose own policy applies)'
const GUARD_READS = 'Read by a guard or a public flow before any tenant context exists'
const OF_A_PERSON = 'A row of a person, not of a store: the id always comes from the token'

export const RLS_EXEMPTIONS: Readonly<Record<string, RlsExemption>> = {
  // Never get a tenant policy
  organizations: neverPolicy(GUARD_READS),
  users: neverPolicy(GUARD_READS),
  sessions: neverPolicy(GUARD_READS),
  verification_tokens: neverPolicy('Magic-link tokens, read before anybody is authenticated'),
  stores: neverPolicy(
    `${GUARD_READS}: the TenantGuard resolves the store and its organization from it`
  ),
  memberships: neverPolicy(`${GUARD_READS}: the TenantGuard lists the stores of a user from it`),
  invitations: neverPolicy('Invitation preview and accept are public and carry only the token'),
  cookie_consents: neverPolicy('Recorded before login, by visitor'),
  processed_webhook_events: neverPolicy(
    'Webhook idempotency keyed by the provider event id, written before the store is known'
  ),
  user_notification_settings: neverPolicy(OF_A_PERSON),
  push_subscriptions: neverPolicy(OF_A_PERSON),

  // Phase 1 (configuration, catalogs, audit, analytics) has its policies: migration 20270121110000_rls_phase1. These two stay global.
  roles: neverPolicy(
    `${GUARD_READS}: the permissions of a member are resolved from it before the context is set`
  ),
  permissions: neverPolicy(`${GUARD_READS}, with its role`),

  // Phase 2: conversations, customers, media
  conversations: pending(2, 'Inbox'),
  conversation_origins: pending(2, 'Inbox'),
  messages: pending(2, 'Inbox'),
  message_reactions: pending(2, 'Inbox'),
  message_revisions: pending(2, 'Inbox'),
  channel_connections: pending(2, 'Channels; inbound webhooks run in the worker'),
  customers: pending(2, 'Customers'),
  customer_identities: pending(2, 'Customers'),
  customer_merges: pending(2, 'Customers'),
  customer_fiscal_data: pending(2, 'Customers'),
  customer_notes: pending(2, BY_PARENT),
  addresses: pending(2, BY_PARENT),
  media: pending(2, 'Files of a store'),
  notifications: pending(2, 'Inbox'),

  // Phase 3: orders, inventory, shipping
  orders: pending(3, 'Orders'),
  order_items: pending(3, BY_PARENT),
  order_item_allocations: pending(3, 'Orders'),
  order_message_templates: pending(3, 'Orders'),
  order_message_dispatches: pending(3, 'Orders'),
  order_returns: pending(3, 'Returns'),
  order_return_lines: pending(3, 'Returns'),
  return_reception_batches: pending(3, 'Returns'),
  return_reception_items: pending(3, 'Returns'),
  products: pending(3, 'Catalog of products'),
  product_variants: pending(3, BY_PARENT),
  inventory_levels: pending(3, 'Inventory'),
  inventory_movements: pending(3, 'Inventory; append only'),
  stock_counts: pending(3, 'Inventory'),
  stock_count_lines: pending(3, 'Inventory'),
  stock_transfers: pending(3, 'Inventory, organization scope'),
  stock_transfer_lines: pending(3, 'Inventory'),
  warehouses: pending(3, 'Inventory, organization scope'),
  store_warehouses: pending(3, 'Inventory'),
  carrier_connections: pending(3, 'Shipping'),
  carrier_services: pending(3, 'Shipping'),
  carrier_status_mappings: pending(3, 'Shipping'),
  carrier_unmapped_statuses: pending(3, 'Shipping'),
  carrier_guide_movements: pending(3, 'Shipping; append only'),
  carrier_guide_policies: pending(3, 'Shipping'),
  carrier_benefit_periods: pending(3, 'Shipping'),
  guide_sequences: pending(3, 'Shipping'),
  shipments: pending(3, 'Shipping'),
  shipment_events: pending(3, 'Shipping'),
  pickup_requests: pending(3, 'Shipping'),
  bulk_label_jobs: pending(3, 'Shipping'),
  cod_remittances: pending(3, 'Remittances'),
  cod_remittance_lines: pending(3, 'Remittances'),
  remittance_import_profiles: pending(3, 'Remittances'),

  // Phase 4: finance and fiscal (the last, by risk)
  account_period_balances: pending(4, 'Ledger'),
  account_role_mappings: pending(4, 'Ledger'),
  ledger_accounts: pending(4, 'Ledger'),
  payment_method_accounts: pending(4, 'Ledger'),
  journal_entries: pending(4, 'Ledger; append only'),
  journal_lines: pending(4, 'Ledger; append only'),
  finance_settings: pending(4, 'Finance'),
  finance_transactions: pending(4, 'Finance'),
  finance_posting_failures: pending(4, 'Finance'),
  finance_chain_incidents: pending(4, 'Finance'),
  finance_book_layouts: pending(4, 'Finance'),
  finance_book_snapshots: pending(4, 'Finance'),
  tax_rates: pending(4, 'Finance'),
  bank_import_profiles: pending(4, 'Bank reconciliation'),
  bank_statement_imports: pending(4, 'Bank reconciliation'),
  bank_statement_lines: pending(4, 'Bank reconciliation'),
  reconciliation_matches: pending(4, 'Bank reconciliation'),
  suppliers: pending(4, 'Purchases'),
  purchase_orders: pending(4, 'Purchases'),
  purchase_order_lines: pending(4, 'Purchases'),
  purchase_receipts: pending(4, 'Purchases'),
  purchase_receipt_lines: pending(4, 'Purchases'),
  supplier_payments: pending(4, 'Purchases'),
  fiscal_periods: pending(4, 'Fiscal'),
  fiscal_issuers: pending(4, 'Fiscal'),
  fiscal_sequences: pending(4, 'Fiscal'),
  fiscal_documents: pending(4, 'Fiscal'),
  fiscal_contingencies: pending(4, 'Fiscal')
}
