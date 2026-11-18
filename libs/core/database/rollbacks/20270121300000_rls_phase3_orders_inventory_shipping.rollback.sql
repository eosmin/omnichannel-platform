-- Rolls back 20270121300000_rls_phase3_orders_inventory_shipping. ORDER: deploy the previous build of the api FIRST, because the
-- current one calls rls_store_tables_with_rows (delete of a store), which would fail with 'function does not exist' the moment it is
-- dropped here. Drops the policies of the 34 tables of phase 3 (and turns row
-- security off on the ones that have a standard policy) and the function. Nothing else changed in that migration, so no data
-- is touched. Safe to run twice.
BEGIN;

SELECT rls_drop_policy('orders');
SELECT rls_drop_policy('products');
SELECT rls_drop_policy('order_item_allocations');
SELECT rls_drop_policy('order_message_templates');
SELECT rls_drop_policy('order_message_dispatches');
SELECT rls_drop_policy('order_returns');
SELECT rls_drop_policy('order_return_lines');
SELECT rls_drop_policy('return_reception_batches');
SELECT rls_drop_policy('return_reception_items');
SELECT rls_drop_policy('inventory_levels');
SELECT rls_drop_policy('inventory_movements');
SELECT rls_drop_policy('stock_count_lines');
SELECT rls_drop_policy('stock_transfer_lines');
SELECT rls_drop_policy('carrier_connections');
SELECT rls_drop_policy('carrier_services');
SELECT rls_drop_policy('carrier_status_mappings');
SELECT rls_drop_policy('carrier_unmapped_statuses');
SELECT rls_drop_policy('carrier_guide_movements');
SELECT rls_drop_policy('carrier_guide_policies');
SELECT rls_drop_policy('carrier_benefit_periods');
SELECT rls_drop_policy('guide_sequences');
SELECT rls_drop_policy('shipments');
SELECT rls_drop_policy('shipment_events');
SELECT rls_drop_policy('pickup_requests');
SELECT rls_drop_policy('bulk_label_jobs');
SELECT rls_drop_policy('cod_remittances');
SELECT rls_drop_policy('cod_remittance_lines');
SELECT rls_drop_policy('remittance_import_profiles');
SELECT rls_drop_policy('warehouses');
SELECT rls_drop_policy('stock_transfers');
SELECT rls_drop_policy('stock_counts');
SELECT rls_drop_policy('store_warehouses');
SELECT rls_drop_policy('order_items');
SELECT rls_drop_policy('product_variants');

DROP FUNCTION IF EXISTS rls_store_tables_with_rows(text);

COMMIT;
