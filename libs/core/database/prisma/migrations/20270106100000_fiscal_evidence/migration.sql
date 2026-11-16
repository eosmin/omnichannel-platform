-- Step 4B.7b-2 (TDD_18 §8.3): the evidence of a fiscal document kept as media. A document keeps, for ever, at most one file of each kind:
-- the document as it was built, what the authority answered to its acceptance, and what it answered to its invalidation. The files are
-- made by the platform (never uploaded), scanned like any file, served only by a signed link to who reads the fiscal documents, and never
-- deleted: the row of a document is immutable once accepted, so the pointer lives on the file (the document is not touched).

-- AlterTable
ALTER TABLE "media" ADD COLUMN "fiscal_document_id" TEXT;
ALTER TABLE "media" ADD COLUMN "fiscal_evidence_kind" TEXT;

-- CreateIndex
CREATE INDEX "media_fiscal_document_id_idx" ON "media"("fiscal_document_id");
-- One file of each kind for a document: asking twice for the same evidence is the same file
CREATE UNIQUE INDEX "uq_media_fiscal_evidence_kind" ON "media"("fiscal_document_id", "fiscal_evidence_kind")
  WHERE fiscal_document_id IS NOT NULL;

-- AddForeignKey
ALTER TABLE "media" ADD CONSTRAINT "media_fiscal_document_id_fkey" FOREIGN KEY ("fiscal_document_id") REFERENCES "fiscal_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A file of evidence has its document and its kind, has no other parent, and only a file of evidence names a document
ALTER TABLE media
  ADD CONSTRAINT chk_media_fiscal_evidence CHECK (
    ((purpose = 'fiscal_evidence') = (fiscal_document_id IS NOT NULL))
    AND ((fiscal_document_id IS NULL) = (fiscal_evidence_kind IS NULL))
    AND (fiscal_evidence_kind IS NULL OR fiscal_evidence_kind IN ('document', 'response', 'void_response'))
    AND (purpose <> 'fiscal_evidence'
         OR (store_id IS NOT NULL AND product_id IS NULL AND order_id IS NULL AND message_id IS NULL AND origin_id IS NULL
             AND customer_id IS NULL AND finance_transaction_id IS NULL AND origin_slot IS NULL))
  );

-- The file is kept in the store of its document: the link that serves it reads it there, and a file of another store or organization is
-- refused here whoever writes
CREATE FUNCTION check_fiscal_evidence_scope() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.purpose = 'fiscal_evidence' AND NOT EXISTS (
    SELECT 1 FROM fiscal_documents d WHERE d.id = NEW.fiscal_document_id AND d.store_id = NEW.store_id
  ) THEN
    RAISE EXCEPTION 'FISCAL_EVIDENCE_SCOPE: the evidence of a fiscal document is kept in the store of the document'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_media_fiscal_evidence_scope
BEFORE INSERT ON media
FOR EACH ROW EXECUTE FUNCTION check_fiscal_evidence_scope();

-- Evidence keeps what made it evidence (the scan moves its status, nothing else moves) and is never deleted
CREATE FUNCTION forbid_fiscal_evidence_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.purpose = 'fiscal_evidence' THEN
      RAISE EXCEPTION 'FISCAL_EVIDENCE_IMMUTABLE: the evidence of a fiscal document is never deleted'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.purpose = 'fiscal_evidence'
     AND (NEW.purpose IS DISTINCT FROM OLD.purpose
          OR NEW.fiscal_document_id IS DISTINCT FROM OLD.fiscal_document_id
          OR NEW.fiscal_evidence_kind IS DISTINCT FROM OLD.fiscal_evidence_kind
          OR NEW.store_id IS DISTINCT FROM OLD.store_id
          OR NEW.key IS DISTINCT FROM OLD.key
          OR NEW.content_type IS DISTINCT FROM OLD.content_type) THEN
    RAISE EXCEPTION 'FISCAL_EVIDENCE_IMMUTABLE: the evidence of a fiscal document keeps its document, kind, store and file'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_media_fiscal_evidence_keeps
BEFORE UPDATE OR DELETE ON media
FOR EACH ROW EXECUTE FUNCTION forbid_fiscal_evidence_change();
