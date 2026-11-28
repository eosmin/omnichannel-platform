-- Finance, returns and VAT: five new roles of the books (criterion of the accountant, kept in a private file) and the accounts they start on.
--
-- Roles: vat_pending_document, accrued_commissions_undocumented, income_tax_prepayment, vat_card_advance and vat_non_recoverable (the output VAT of
-- a return that came back after the three months of the law, which is an expense). The CHECK of the roles lists every role of AccountRole.
--
-- The organizations that already have their books get the five accounts, and the five mappings, ONLY when it is safe: the code is free (any case),
-- and the header it goes under exists in that organization with the same type and takes no entries. An organization whose chart already uses a code,
-- or that no longer has the header, is left alone: its role stays unmapped and the entry that needs it fails visibly (TDD_18 §6.1) instead of falling
-- into an account that means something else. Nothing existing is renamed, moved or changed. The rows written here are marked by their id (a
-- deterministic uuid of the organization and the code) so the rollback finds exactly them; they are NOT system accounts, so the rollback may delete
-- one that has no entries (the guard refuses to delete a system account). Idempotent: a second run finds them done.
-- Rollback: rollbacks/20270217100000_finance_returns_vat_roles.rollback.sql
ALTER TABLE account_role_mappings DROP CONSTRAINT chk_account_role_mappings_role;
ALTER TABLE account_role_mappings
  ADD CONSTRAINT chk_account_role_mappings_role CHECK (role IN (
    'cash_default', 'bank_default', 'inventory', 'inventory_in_transit', 'receivable_carriers', 'customer_advances',
    'payable_suppliers', 'payable_carriers', 'vat_output', 'vat_input', 'sales_revenue', 'shipping_revenue', 'sales_discounts',
    'sales_returns', 'cost_of_goods_sold', 'inventory_loss', 'inventory_gain', 'prepaid_carrier_guides', 'carrier_freight_expense',
    'carrier_commission_expense', 'cod_differences', 'opening_equity', 'rounding', 'uncategorized_expense',
    'vat_pending_document', 'accrued_commissions_undocumented', 'income_tax_prepayment', 'vat_card_advance', 'vat_non_recoverable'
  ));

DROP TABLE IF EXISTS pg_temp._finance_returns_vat_roles;
CREATE TEMP TABLE _finance_returns_vat_roles (
  role TEXT PRIMARY KEY, code TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, normal_side TEXT NOT NULL, parent_code TEXT NOT NULL
);
INSERT INTO _finance_returns_vat_roles VALUES
  ('vat_pending_document', '1402', 'IVA pendiente de documentar', 'asset', 'debit', '14'),
  ('income_tax_prepayment', '1405', 'Pago a cuenta de renta', 'asset', 'debit', '14'),
  ('vat_card_advance', '1406', 'Anticipo de IVA 2 % de tarjetas', 'asset', 'debit', '14'),
  ('accrued_commissions_undocumented', '2103', 'Comisiones devengadas sin comprobante', 'liability', 'credit', '21'),
  ('vat_non_recoverable', '6113', 'IVA no recuperable', 'expense', 'debit', '6');

INSERT INTO ledger_accounts (id, organization_id, code, name, type, normal_side, parent_id, is_postable, is_system, created_at, updated_at)
SELECT md5(s.organization_id || ':finance_returns_vat:' || r.code)::uuid::text, s.organization_id, r.code, r.name, r.type, r.normal_side,
       parent.id, true, false, now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC'
FROM finance_settings s
CROSS JOIN _finance_returns_vat_roles r
JOIN ledger_accounts parent
  ON parent.organization_id = s.organization_id AND lower(parent.code) = lower(r.parent_code)
 AND parent.type = r.type AND NOT parent.is_postable
WHERE NOT EXISTS (
  SELECT 1 FROM ledger_accounts taken WHERE taken.organization_id = s.organization_id AND lower(taken.code) = lower(r.code)
)
ON CONFLICT DO NOTHING;

INSERT INTO account_role_mappings (organization_id, role, account_id)
SELECT a.organization_id, r.role, a.id
FROM _finance_returns_vat_roles r
JOIN ledger_accounts a ON a.code = r.code AND a.id = md5(a.organization_id || ':finance_returns_vat:' || r.code)::uuid::text
ON CONFLICT (organization_id, role) DO NOTHING;

DROP TABLE pg_temp._finance_returns_vat_roles;
