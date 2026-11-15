-- AlterTable
ALTER TABLE "finance_transactions" ADD COLUMN "document_media_id" TEXT;

-- AlterTable
ALTER TABLE "media" ADD COLUMN "finance_transaction_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "finance_transactions_document_media_id_key" ON "finance_transactions"("document_media_id");

-- CreateIndex
CREATE INDEX "media_finance_transaction_id_idx" ON "media"("finance_transaction_id");

-- AddForeignKey
ALTER TABLE "media" ADD CONSTRAINT "media_finance_transaction_id_fkey" FOREIGN KEY ("finance_transaction_id") REFERENCES "finance_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_transactions" ADD CONSTRAINT "finance_transactions_document_media_id_fkey" FOREIGN KEY ("document_media_id") REFERENCES "media"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================================================
-- Step 4B.4b (TDD_18 §2.6, §4.3): the receipt of a transaction. A file is uploaded FOR a transaction (media.finance_transaction_id, the
-- parent check of the upload) and the transaction then points at it, once. The transaction stays what it was: the pointer is the only
-- other column that may move besides the one that voids it, it moves from null to a file and never again, and the file must be one
-- made for THIS transaction, of the purpose of a receipt, in a store of the SAME organization (so a file of another organization is
-- refused here whoever writes). A receipt of a voided transaction is not attached.
-- ============================================================================================================
-- A receipt has one parent and no other: a finance file never carries the product, order, message, origin or customer of another
-- purpose's gallery, and only a finance file names a transaction
ALTER TABLE media
  ADD CONSTRAINT chk_media_finance_parent CHECK (
    (finance_transaction_id IS NULL OR purpose = 'finance_document')
    AND (purpose <> 'finance_document'
         OR (product_id IS NULL AND order_id IS NULL AND message_id IS NULL AND origin_id IS NULL AND customer_id IS NULL))
  );

-- Once a transaction points at a file, the file keeps what made it that transaction's receipt: its purpose, its parent and its store
CREATE FUNCTION forbid_finance_receipt_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  IF (NEW.purpose IS DISTINCT FROM OLD.purpose
      OR NEW.finance_transaction_id IS DISTINCT FROM OLD.finance_transaction_id
      OR NEW.store_id IS DISTINCT FROM OLD.store_id)
     AND EXISTS (SELECT 1 FROM finance_transactions WHERE document_media_id = OLD.id) THEN
    RAISE EXCEPTION 'FINANCE_TRANSACTION_DOCUMENT: the file is the receipt of a transaction and keeps its purpose, parent and store';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_media_finance_receipt_keeps
BEFORE UPDATE OF purpose, finance_transaction_id, store_id ON media
FOR EACH ROW EXECUTE FUNCTION forbid_finance_receipt_change();

CREATE OR REPLACE FUNCTION check_finance_transaction_row() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
DECLARE
  moved_from ledger_accounts%ROWTYPE;
  moved_to ledger_accounts%ROWTYPE;
  category ledger_accounts%ROWTYPE;
  posted journal_entries%ROWTYPE;
  voiding journal_entries%ROWTYPE;
  replaced finance_transactions%ROWTYPE;
  receipt media%ROWTYPE;
  receipt_org text;
  is_voiding boolean;
  is_documenting boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A transaction is born live: only the one update below voids it, and what it replaces was voided by the reversal of its entry
    IF NEW.voided_by_entry_id IS NOT NULL THEN
      RAISE EXCEPTION 'FINANCE_TRANSACTION_IMMUTABLE: a transaction is born live and voided by an update';
    END IF;
    -- The receipt is made FOR a transaction that exists, so a new one has none
    IF NEW.document_media_id IS NOT NULL THEN
      RAISE EXCEPTION 'FINANCE_TRANSACTION_IMMUTABLE: a transaction is born without a receipt; it is attached by an update';
    END IF;
    IF NEW.replaces_transaction_id IS NOT NULL THEN
      SELECT * INTO replaced FROM finance_transactions WHERE id = NEW.replaces_transaction_id AND organization_id = NEW.organization_id;
      SELECT * INTO voiding FROM journal_entries WHERE id = replaced.voided_by_entry_id AND organization_id = NEW.organization_id;
      IF replaced.id IS NULL OR replaced.kind <> NEW.kind OR voiding.reverses_entry_id IS DISTINCT FROM replaced.entry_id THEN
        RAISE EXCEPTION 'FINANCE_TRANSACTION_ENTRY: what it replaces is not a voided transaction of its kind';
      END IF;
    END IF;
    IF NEW.from_account_id IS NOT NULL THEN
      SELECT * INTO moved_from FROM ledger_accounts WHERE id = NEW.from_account_id AND organization_id = NEW.organization_id;
      IF moved_from.cash_kind IS NULL THEN
        RAISE EXCEPTION 'FINANCE_TRANSACTION_ACCOUNT: the source of the money is not a cash, bank or wallet account';
      END IF;
    END IF;
    IF NEW.to_account_id IS NOT NULL THEN
      SELECT * INTO moved_to FROM ledger_accounts WHERE id = NEW.to_account_id AND organization_id = NEW.organization_id;
      IF moved_to.cash_kind IS NULL THEN
        RAISE EXCEPTION 'FINANCE_TRANSACTION_ACCOUNT: the destination of the money is not a cash, bank or wallet account';
      END IF;
    END IF;
    IF NEW.category_account_id IS NOT NULL THEN
      SELECT * INTO category FROM ledger_accounts WHERE id = NEW.category_account_id AND organization_id = NEW.organization_id;
      IF (NEW.kind = 'expense' AND category.type <> 'expense') OR (NEW.kind = 'income' AND category.type <> 'income') THEN
        RAISE EXCEPTION 'FINANCE_TRANSACTION_ACCOUNT: the category is not an account of the type of the transaction';
      END IF;
    END IF;
    -- The entry it belongs to: the one of its kind, from this transaction, for its amount, written by a person
    SELECT * INTO posted FROM journal_entries WHERE id = NEW.entry_id AND organization_id = NEW.organization_id;
    IF posted.type IS DISTINCT FROM NEW.kind
       OR posted.source_type IS DISTINCT FROM 'finance_transaction'
       OR posted.source_id IS DISTINCT FROM NEW.id
       OR posted.total_cents IS DISTINCT FROM NEW.amount_cents
       OR posted.entry_date IS DISTINCT FROM NEW.occurred_on
       OR posted.reverses_entry_id IS NOT NULL THEN
      RAISE EXCEPTION 'FINANCE_TRANSACTION_ENTRY: the entry is not the one this transaction posts';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: two columns may move, each from null to a value once and never together: the pointer to the voiding entry (to the reversal
  -- of this transaction's entry) and the pointer to the receipt. Nothing else moves.
  is_voiding := OLD.voided_by_entry_id IS NULL AND NEW.voided_by_entry_id IS NOT NULL;
  is_documenting := OLD.document_media_id IS NULL AND NEW.document_media_id IS NOT NULL;
  IF is_voiding = is_documenting
     OR (to_jsonb(NEW) - 'voided_by_entry_id' - 'document_media_id') IS DISTINCT FROM (to_jsonb(OLD) - 'voided_by_entry_id' - 'document_media_id')
     OR (is_voiding AND NEW.document_media_id IS DISTINCT FROM OLD.document_media_id)
     OR (is_documenting AND NEW.voided_by_entry_id IS DISTINCT FROM OLD.voided_by_entry_id) THEN
    RAISE EXCEPTION 'FINANCE_TRANSACTION_IMMUTABLE: a transaction is voided once, gets one receipt once and is never changed';
  END IF;
  IF is_voiding THEN
    SELECT * INTO voiding FROM journal_entries WHERE id = NEW.voided_by_entry_id AND organization_id = NEW.organization_id;
    IF voiding.reverses_entry_id IS DISTINCT FROM NEW.entry_id THEN
      RAISE EXCEPTION 'FINANCE_TRANSACTION_ENTRY: the entry that voids it does not reverse its entry';
    END IF;
    RETURN NEW;
  END IF;
  -- The receipt: a file made for this transaction, of the purpose of a receipt, in a store of this organization
  IF OLD.voided_by_entry_id IS NOT NULL THEN
    RAISE EXCEPTION 'FINANCE_TRANSACTION_DOCUMENT: a voided transaction takes no receipt';
  END IF;
  SELECT * INTO receipt FROM media WHERE id = NEW.document_media_id;
  SELECT organization_id INTO receipt_org FROM stores WHERE id = receipt.store_id;
  -- Only a file the scan found clean: the pointer is set once, and an infected or unscanned file would be the receipt for ever
  IF receipt.id IS NULL
     OR receipt.status IS DISTINCT FROM 'clean'
     OR receipt.purpose IS DISTINCT FROM 'finance_document'
     OR receipt.finance_transaction_id IS DISTINCT FROM NEW.id
     OR receipt_org IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'FINANCE_TRANSACTION_DOCUMENT: the file is not a receipt made for this transaction';
  END IF;
  RETURN NEW;
END $$;

-- The application roles may add a transaction, point it at the entry that voids it and at its receipt: no other column is theirs to change
GRANT UPDATE (document_media_id) ON TABLE finance_transactions TO platform_app, platform_worker;
