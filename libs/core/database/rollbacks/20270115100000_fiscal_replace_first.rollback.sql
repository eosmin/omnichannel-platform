-- Rolls back 20270115100000_fiscal_replace_first. It refuses to run while a live replacement exists whose original is not voided: the restored
-- rules (one live sale document per order, a replacement only of a voided document) would be broken by that pair. Void the original (or
-- decide with the accountant which of the two documents stands) first. Run it before the code that makes a replacement first is brought
-- back, and stop the code that makes a replacement first (an older release) before it: the script takes a lock that keeps writers out of the
-- table while it checks and swaps. Safe to run twice.
BEGIN;
LOCK TABLE fiscal_documents IN SHARE ROW EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM fiscal_documents r
    JOIN fiscal_documents o ON o.id = r.replaces_document_id
    WHERE o.status <> 'voided' AND r.status <> 'voided'
  ) THEN
    RAISE EXCEPTION 'a live replacement exists whose original is not voided: void the original first';
  END IF;
END
$$;
DROP INDEX IF EXISTS "uq_fiscal_documents_live_replacement";
DROP INDEX IF EXISTS "uq_fiscal_documents_live_sale";
CREATE UNIQUE INDEX "uq_fiscal_documents_live_sale" ON "fiscal_documents"("organization_id", "order_id")
  WHERE kind = 'sale' AND status <> 'voided';

-- The guard as 20261223100000_fiscal_credit_notes made it
CREATE OR REPLACE FUNCTION check_fiscal_document_scope() RETURNS trigger
SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM orders o JOIN stores s ON s.id = o.store_id
    WHERE o.id = NEW.order_id AND s.id = NEW.store_id AND s.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'the order of a fiscal document belongs to its store and its organization' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.return_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM order_returns r WHERE r.id = NEW.return_id AND r.order_id = NEW.order_id AND r.store_id = NEW.store_id
  ) THEN
    RAISE EXCEPTION 'the return of a credit note belongs to the order and the store of the document' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.parent_document_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM fiscal_documents p
    WHERE p.id = NEW.parent_document_id AND p.organization_id = NEW.organization_id AND p.order_id = NEW.order_id AND p.kind = 'sale'
  ) THEN
    RAISE EXCEPTION 'the original of a credit note is a sale document of the same order' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.replaces_document_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM fiscal_documents p
    WHERE p.id = NEW.replaces_document_id AND p.organization_id = NEW.organization_id AND p.order_id = NEW.order_id
      AND p.kind = 'sale' AND p.status = 'voided'
  ) THEN
    RAISE EXCEPTION 'a fiscal document replaces a voided sale document of the same order' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
COMMIT;
