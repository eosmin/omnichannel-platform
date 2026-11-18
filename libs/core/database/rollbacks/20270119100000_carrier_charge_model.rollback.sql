-- Rolls back 20270119100000_carrier_charge_model: drops the charge model of the connections and takes the new role out of the roles that
-- may be mapped. A mapping of the new role is deleted first (the old CHECK refuses it): the guides bought in advance are then booked by no
-- account, so roll this back only with no prepaid connection in use. Idempotent.
BEGIN;

DELETE FROM account_role_mappings WHERE role = 'prepaid_carrier_guides';
ALTER TABLE account_role_mappings DROP CONSTRAINT IF EXISTS chk_account_role_mappings_role;
ALTER TABLE account_role_mappings
  ADD CONSTRAINT chk_account_role_mappings_role CHECK (role IN (
    'cash_default', 'bank_default', 'inventory', 'inventory_in_transit', 'receivable_carriers', 'customer_advances',
    'payable_suppliers', 'payable_carriers', 'vat_output', 'vat_input', 'sales_revenue', 'shipping_revenue', 'sales_discounts',
    'sales_returns', 'cost_of_goods_sold', 'inventory_loss', 'inventory_gain', 'carrier_freight_expense',
    'carrier_commission_expense', 'cod_differences', 'opening_equity', 'rounding', 'uncategorized_expense'
  ));

ALTER TABLE carrier_connections DROP CONSTRAINT IF EXISTS chk_carrier_connections_charge_model;
ALTER TABLE carrier_guide_movements DROP COLUMN IF EXISTS on_advance;
ALTER TABLE carrier_connections DROP COLUMN IF EXISTS charge_model;

COMMIT;
