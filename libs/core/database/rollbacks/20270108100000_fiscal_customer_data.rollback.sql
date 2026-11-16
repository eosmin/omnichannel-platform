-- Rolls back 20270108100000_fiscal_customer_data. It refuses to run while a customer has fiscal data: it is personal and tax data the store
-- entered, and dropping the table destroys it (the fiscal documents already made keep their own copy). Export it and decide first.
-- Safe to run twice.
BEGIN;
DO $$
DECLARE
  has_rows boolean := false;
BEGIN
  -- Dynamic, so the block parses when the table is already gone (a second run)
  IF to_regclass('customer_fiscal_data') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM customer_fiscal_data)' INTO has_rows;
  END IF;
  IF has_rows THEN
    RAISE EXCEPTION 'customers have fiscal data: export it before rolling back';
  END IF;
END
$$;
DELETE FROM "permissions" WHERE "name" IN ('fiscal:view_customer_data', 'fiscal:manage_customer_data');
DROP TRIGGER IF EXISTS trg_customer_fiscal_data_scope ON customer_fiscal_data;
DROP FUNCTION IF EXISTS customer_fiscal_data_scope();
DROP TABLE IF EXISTS customer_fiscal_data;
COMMIT;
