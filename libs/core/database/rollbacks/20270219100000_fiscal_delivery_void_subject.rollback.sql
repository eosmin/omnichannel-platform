-- Rolls back 20270219100000_fiscal_delivery_void_subject: the guard goes, the subject goes and the key is the document alone again, with the outcome
-- check of 20270208100000. A delivery of an invalidation is a record of what a receiver was given and is never deleted, so this FAILS, on purpose
-- and with nothing changed, while one exists. Safe to run twice (the second run finds the column gone and has nothing left to look at).
BEGIN;
DO $$
DECLARE
  held boolean := false;
BEGIN
  -- Dynamic, so a second run (the column already gone) never plans a statement that names it
  IF EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.fiscal_deliveries'::regclass AND attname = 'subject' AND NOT attisdropped
  ) THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.fiscal_deliveries WHERE subject = ''void'')' INTO held;
  END IF;
  IF held THEN
    RAISE EXCEPTION 'a delivery of an invalidation exists and is never deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
END
$$;
DROP TRIGGER IF EXISTS trg_fiscal_delivery_guard ON fiscal_deliveries;
DROP FUNCTION IF EXISTS fiscal_delivery_guard();
ALTER TABLE fiscal_deliveries DROP CONSTRAINT IF EXISTS chk_fiscal_deliveries_void_only;
ALTER TABLE fiscal_deliveries DROP CONSTRAINT IF EXISTS chk_fiscal_deliveries_outcome;
ALTER TABLE fiscal_deliveries ADD CONSTRAINT chk_fiscal_deliveries_outcome CHECK (
  (status = 'sent' AND route IN ('channel', 'email') AND reason IS NULL
      AND hand_means IS NULL AND handed_over_by IS NULL AND handed_over_at IS NULL)
  OR (status = 'sent' AND route = 'manual' AND hand_means IN ('download', 'paper')
      AND handed_over_by IS NOT NULL AND handed_over_at IS NOT NULL
      AND (reason IS NULL OR reason IN ('no_channel', 'files_unavailable', 'too_large', 'customer_erased')))
  OR (status = 'not_sent' AND route = 'none'
      AND reason IN ('no_channel', 'files_unavailable', 'too_large', 'customer_erased')
      AND hand_means IS NULL AND handed_over_by IS NULL AND handed_over_at IS NULL)
);
DROP INDEX IF EXISTS fiscal_deliveries_document_id_subject_key;
CREATE UNIQUE INDEX IF NOT EXISTS fiscal_deliveries_document_id_key ON fiscal_deliveries (document_id);
ALTER TABLE fiscal_deliveries DROP CONSTRAINT IF EXISTS chk_fiscal_deliveries_subject;
ALTER TABLE fiscal_deliveries DROP COLUMN IF EXISTS subject;
COMMIT;
