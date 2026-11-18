-- Rolls back 20261217100000_finance_receipts. DESTRUCTIVE: the link of each transaction to its receipt is DROPPED (the files stay in
-- their bucket and their media rows stay, as files of a store, but nothing says which transaction they were for: take a copy of
-- finance_transactions.document_media_id and media.finance_transaction_id first if that matters). Brings back the trigger function as
-- 20261216100000 made it, in which a transaction takes no change but its voiding pointer. Run it before the code that reads the
-- columns is brought back. Safe to run twice, also after the rollback of 20261216100000 dropped finance_transactions (ALTER TABLE IF EXISTS).
BEGIN;

-- (the grant on document_media_id goes with the column below)
DROP TRIGGER IF EXISTS trg_media_finance_receipt_keeps ON media;
DROP FUNCTION IF EXISTS forbid_finance_receipt_change();
ALTER TABLE media DROP CONSTRAINT IF EXISTS chk_media_finance_parent;
ALTER TABLE media DROP CONSTRAINT IF EXISTS media_finance_transaction_id_fkey;
ALTER TABLE IF EXISTS finance_transactions DROP CONSTRAINT IF EXISTS finance_transactions_document_media_id_fkey;
DROP INDEX IF EXISTS finance_transactions_document_media_id_key;
DROP INDEX IF EXISTS media_finance_transaction_id_idx;

-- A receipt cannot be a column the old trigger does not know: it is dropped before the function is replaced, because the old function
-- reads the row as a whole (to_jsonb) and a column it does not know would count as a change
ALTER TABLE IF EXISTS finance_transactions DROP COLUMN IF EXISTS document_media_id;
ALTER TABLE IF EXISTS media DROP COLUMN IF EXISTS finance_transaction_id;

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
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.voided_by_entry_id IS NOT NULL THEN
      RAISE EXCEPTION 'FINANCE_TRANSACTION_IMMUTABLE: a transaction is born live and voided by an update';
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

  IF NEW.voided_by_entry_id IS NULL OR OLD.voided_by_entry_id IS NOT NULL THEN
    RAISE EXCEPTION 'FINANCE_TRANSACTION_IMMUTABLE: a transaction is voided once and never changed';
  END IF;
  IF (to_jsonb(NEW) - 'voided_by_entry_id') IS DISTINCT FROM (to_jsonb(OLD) - 'voided_by_entry_id') THEN
    RAISE EXCEPTION 'FINANCE_TRANSACTION_IMMUTABLE: a transaction is voided once and never changed';
  END IF;
  SELECT * INTO voiding FROM journal_entries WHERE id = NEW.voided_by_entry_id AND organization_id = NEW.organization_id;
  IF voiding.reverses_entry_id IS DISTINCT FROM NEW.entry_id THEN
    RAISE EXCEPTION 'FINANCE_TRANSACTION_ENTRY: the entry that voids it does not reverse its entry';
  END IF;
  RETURN NEW;
END $$;

COMMIT;
