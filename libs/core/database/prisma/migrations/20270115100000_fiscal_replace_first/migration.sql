-- Step 4B.7c-5b: the replacement of a sale document can be made BEFORE the original is invalidated (the authority asks for the replacement's
-- generation code first for some kinds of invalidation). Until then a replacement needed a voided original.
--
-- 1. At most one live ORIGINAL sale document per order and at most one live REPLACEMENT (a document that carries `replaces_document_id`).
--    While the original is not voided yet, the order has two live sale documents on purpose (the original and its replacement); a third
--    one, or a replacement of the replacement, meets the second index. `uq_fiscal_documents_replaces` already says a document is replaced once.
DROP INDEX IF EXISTS "uq_fiscal_documents_live_sale";
CREATE UNIQUE INDEX "uq_fiscal_documents_live_sale" ON "fiscal_documents"("organization_id", "order_id")
  WHERE kind = 'sale' AND status <> 'voided' AND replaces_document_id IS NULL;
CREATE UNIQUE INDEX "uq_fiscal_documents_live_replacement" ON "fiscal_documents"("organization_id", "order_id")
  WHERE kind = 'sale' AND status <> 'voided' AND replaces_document_id IS NOT NULL;

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
  -- A sale document that replaces nothing is the first one of its order: once the order has a sale document, voided or not, the next one is a
  -- replacement (the index above no longer sees an original once its replacement stands)
  IF TG_OP = 'INSERT' AND NEW.kind = 'sale' AND NEW.replaces_document_id IS NULL AND EXISTS (
    SELECT 1 FROM fiscal_documents s
    WHERE s.organization_id = NEW.organization_id AND s.order_id = NEW.order_id AND s.kind = 'sale' AND s.id <> NEW.id
  ) THEN
    RAISE EXCEPTION 'the sale document of an order that has one is replaced, not made again' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
