-- Step 4B.7c-5b: the replacement of a sale document can be made BEFORE the original is invalidated (the authority asks for the replacement's
-- generation code first for some kinds of invalidation). Until then a replacement needed a voided original.
--
-- 1. One live sale document per order stays the rule for the ORIGINAL documents: a document that replaces another (it carries
--    `replaces_document_id`) is left out of that index, and `uq_fiscal_documents_replaces` already says that a document is replaced once. While
--    the original is not voided yet, the order has two live sale documents on purpose; once it is voided, only the replacement is live.
DROP INDEX IF EXISTS "uq_fiscal_documents_live_sale";
CREATE UNIQUE INDEX "uq_fiscal_documents_live_sale" ON "fiscal_documents"("organization_id", "order_id")
  WHERE kind = 'sale' AND status <> 'voided' AND replaces_document_id IS NULL;

-- 2. The replaced document is a sale document of the same order that the authority has: accepted (replacement made first) or voided (the
--    replacement made after). One that is queued, sent or refused is not at the authority, so nothing can replace it.
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
      AND p.kind = 'sale' AND p.status IN ('accepted', 'voided')
  ) THEN
    RAISE EXCEPTION 'a fiscal document replaces an accepted or voided sale document of the same order' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
