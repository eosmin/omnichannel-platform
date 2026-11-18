-- Step 4B.6b-4 (HC-101): how a carrier connection charges the business for its guides, and the account of the guides bought in advance.
--
-- carrier_connections.charge_model: 'invoiced' (the carrier bills later: E4 as written), 'remittance' (the carrier deducts its charge from
-- the cash it remits) or 'prepaid' (the business bought guides in advance; each guide consumes the advance and is never owed again). Every
-- connection that exists keeps posting as it did, so the default is 'invoiced'.
ALTER TABLE carrier_connections
  ADD COLUMN charge_model TEXT NOT NULL DEFAULT 'invoiced',
  ADD CONSTRAINT chk_carrier_connections_charge_model CHECK (charge_model IN ('invoiced', 'remittance', 'prepaid'));

-- The new role of the books: the guides bought and not used yet (an asset). The CHECK lists every role of AccountRole.
ALTER TABLE account_role_mappings DROP CONSTRAINT chk_account_role_mappings_role;
ALTER TABLE account_role_mappings
  ADD CONSTRAINT chk_account_role_mappings_role CHECK (role IN (
    'cash_default', 'bank_default', 'inventory', 'inventory_in_transit', 'receivable_carriers', 'customer_advances',
    'payable_suppliers', 'payable_carriers', 'vat_output', 'vat_input', 'sales_revenue', 'shipping_revenue', 'sales_discounts',
    'sales_returns', 'cost_of_goods_sold', 'inventory_loss', 'inventory_gain', 'prepaid_carrier_guides', 'carrier_freight_expense',
    'carrier_commission_expense', 'cod_differences', 'opening_equity', 'rounding', 'uncategorized_expense'
  ));

-- carrier_guide_movements.on_advance: a guide that was made while the connection was prepaid took its cost out of the advance. The fact is
-- written with the consume (the ledger is append-only), so a later change of the model never moves a guide already made. What was consumed
-- before this column is false: it is in the opening balance, or in the entry the accountant makes when the model is switched on.
ALTER TABLE carrier_guide_movements ADD COLUMN on_advance BOOLEAN NOT NULL DEFAULT false;
