-- Row-Level Security, phase 3: orders, inventory, shipping, returns and remittances (TDD_01 section 3.2, layer 3). The policies are
-- DECLARED here; none binds anybody until the owner turns enforcement on (rls_set_enforcement), so nothing changes for the
-- application by running this file.
--
-- Scope of each table (the column that says whose row it is):
--   store                 the table has a store_id that is never null
--   organization          the inventory resources that belong to the organization (TDD_16 section 1). stock_counts has a nullable
--                         store_id as well: the organization is what decides
--   store_or_organization store_warehouses (a row of a store and of an organization: either one in the context shows it)
--   through its parent    order_items and product_variants have no owner column; a row is seen when its parent is seen. The policy
--                         of the parent applies inside the sub-select, and the foreign key is indexed

SELECT rls_apply_policy('orders', 'store');
SELECT rls_apply_policy('products', 'store');
SELECT rls_apply_policy('order_item_allocations', 'store');
SELECT rls_apply_policy('order_message_templates', 'store');
SELECT rls_apply_policy('order_message_dispatches', 'store');
SELECT rls_apply_policy('order_returns', 'store');
SELECT rls_apply_policy('order_return_lines', 'store');
SELECT rls_apply_policy('return_reception_batches', 'store');
SELECT rls_apply_policy('return_reception_items', 'store');
SELECT rls_apply_policy('inventory_levels', 'store');
SELECT rls_apply_policy('inventory_movements', 'store');
SELECT rls_apply_policy('stock_count_lines', 'store');
SELECT rls_apply_policy('stock_transfer_lines', 'store');
SELECT rls_apply_policy('carrier_connections', 'store');
SELECT rls_apply_policy('carrier_services', 'store');
SELECT rls_apply_policy('carrier_status_mappings', 'store');
SELECT rls_apply_policy('carrier_unmapped_statuses', 'store');
SELECT rls_apply_policy('carrier_guide_movements', 'store');
SELECT rls_apply_policy('carrier_guide_policies', 'store');
SELECT rls_apply_policy('carrier_benefit_periods', 'store');
SELECT rls_apply_policy('guide_sequences', 'store');
SELECT rls_apply_policy('shipments', 'store');
SELECT rls_apply_policy('shipment_events', 'store');
SELECT rls_apply_policy('pickup_requests', 'store');
SELECT rls_apply_policy('bulk_label_jobs', 'store');
SELECT rls_apply_policy('cod_remittances', 'store');
SELECT rls_apply_policy('cod_remittance_lines', 'store');
SELECT rls_apply_policy('remittance_import_profiles', 'store');

SELECT rls_apply_policy('warehouses', 'organization');
SELECT rls_apply_policy('stock_transfers', 'organization');
SELECT rls_apply_policy('stock_counts', 'organization');

SELECT rls_apply_policy('store_warehouses', 'store_or_organization');

-- The tables with no owner column: the same two policies as rls_apply_policy gives (<table>_tenant for the application roles,
-- <table>_owner for the owner of the table, which is the role that runs this migration), the predicate being the parent.
CREATE POLICY order_items_tenant ON order_items AS PERMISSIVE FOR ALL TO platform_app, platform_worker
  USING (EXISTS (SELECT 1 FROM orders p WHERE p.id = order_items.order_id))
  WITH CHECK (EXISTS (SELECT 1 FROM orders p WHERE p.id = order_items.order_id));
CREATE POLICY order_items_owner ON order_items AS PERMISSIVE FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);
CREATE POLICY product_variants_tenant ON product_variants AS PERMISSIVE FOR ALL TO platform_app, platform_worker
  USING (EXISTS (SELECT 1 FROM products p WHERE p.id = product_variants.product_id))
  WITH CHECK (EXISTS (SELECT 1 FROM products p WHERE p.id = product_variants.product_id));
CREATE POLICY product_variants_owner ON product_variants AS PERMISSIVE FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);

-- Which tables hold rows of a store, for the delete of a store (OrganizationsService.deleteStore). A store that holds any data is
-- not deleted, because deleting the store cascades to every row it owns. The old query counted with the caller's own rights, so
-- once row security is on it would have counted ZERO rows of every table and let the delete wipe the data. This runs with the
-- rights of its owner (the role of the migrations, the owner of the tables, whose policy shows every row) and refuses to answer
-- when it cannot see every row: an error stops the delete, a wrong zero would not. It only reads.
CREATE FUNCTION rls_store_tables_with_rows(p_store_id text, p_skip text[])
  RETURNS TABLE (table_name text, row_count integer)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  DECLARE
    rel record;
    sees_all boolean;
    found_any boolean := false;
    n integer;
  BEGIN
    IF p_store_id IS NULL OR p_store_id = '' THEN
      RAISE EXCEPTION 'rls_store_tables_with_rows: a store id is required';
    END IF;
    SELECT r.rolsuper OR r.rolbypassrls INTO sees_all FROM pg_roles r WHERE r.rolname = current_user;
    FOR rel IN
      SELECT c.oid, c.relname::text AS relname, c.relowner
      FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'store_id' AND NOT a.attisdropped AND a.attnum > 0
      WHERE ns.nspname = 'public' AND c.relkind IN ('r', 'p')
        AND c.relname::text <> ALL (coalesce(p_skip, ARRAY[]::text[]))
      ORDER BY c.relname
    LOOP
      -- Closed: a table this role does not own and cannot bypass may hide rows from the count
      IF NOT coalesce(sees_all, false) AND rel.relowner <> (SELECT r.oid FROM pg_roles r WHERE r.rolname = current_user) THEN
        RAISE EXCEPTION 'rls_store_tables_with_rows: cannot see every row of %', rel.relname;
      END IF;
      found_any := true;
      EXECUTE format('SELECT count(*)::integer FROM public.%I WHERE store_id = $1', rel.relname) INTO n USING p_store_id;
      IF n > 0 THEN
        table_name := rel.relname;
        row_count := n;
        RETURN NEXT;
      END IF;
    END LOOP;
    IF NOT found_any THEN
      RAISE EXCEPTION 'rls_store_tables_with_rows: no table with a store_id was found';
    END IF;
  END
  $$;

REVOKE ALL ON FUNCTION rls_store_tables_with_rows(text, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rls_store_tables_with_rows(text, text[]) TO platform_app, platform_worker;

-- The webhook of a carrier names a connection and nothing else: no store, no session. This answers the ids that open the context
-- of that store, and the status; never the credentials or the webhook secret (the service reads them once the context is open).
-- The id is a uuid, which nobody can list. It only reads.
CREATE FUNCTION rls_resolve_carrier_connection(p_connection_id text)
  RETURNS TABLE (id text, store_id text, organization_id text, carrier_id text, status text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT cc.id, cc.store_id, s.organization_id, cc.carrier_id, cc.status
    FROM public.carrier_connections cc
    JOIN public.stores s ON s.id = cc.store_id
    WHERE cc.id = p_connection_id
  $$;

REVOKE ALL ON FUNCTION rls_resolve_carrier_connection(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rls_resolve_carrier_connection(text) TO platform_app, platform_worker;
