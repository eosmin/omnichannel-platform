-- Rolls back 20261224130000_fiscal_evidence. It refuses to run while a file of evidence exists: the evidence of a fiscal document is legal
-- evidence and dropping the link would leave files in the bucket that nothing says belong to a document. Export the rows of media with
-- purpose 'fiscal_evidence' and decide with the accountant first. Run it before the code that reads the columns is brought back.
-- Safe to run twice.
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'media' AND column_name = 'fiscal_document_id')
     AND EXISTS (SELECT 1 FROM media WHERE purpose = 'fiscal_evidence') THEN
    RAISE EXCEPTION 'fiscal evidence exists: export it before rolling back';
  END IF;
END
$$;
DROP TRIGGER IF EXISTS trg_media_fiscal_evidence_keeps ON media;
DROP TRIGGER IF EXISTS trg_media_fiscal_evidence_scope ON media;
DROP FUNCTION IF EXISTS forbid_fiscal_evidence_change();
DROP FUNCTION IF EXISTS check_fiscal_evidence_scope();
ALTER TABLE media DROP CONSTRAINT IF EXISTS chk_media_fiscal_evidence;
ALTER TABLE media DROP CONSTRAINT IF EXISTS media_fiscal_document_id_fkey;
DROP INDEX IF EXISTS uq_media_fiscal_evidence_kind;
DROP INDEX IF EXISTS media_fiscal_document_id_idx;
ALTER TABLE media DROP COLUMN IF EXISTS fiscal_evidence_kind;
ALTER TABLE media DROP COLUMN IF EXISTS fiscal_document_id;
COMMIT;
