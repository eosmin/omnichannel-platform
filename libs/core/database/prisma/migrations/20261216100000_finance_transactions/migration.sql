-- CreateTable
CREATE TABLE "finance_transactions" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "store_id" TEXT,
    "kind" TEXT NOT NULL,
    "occurred_on" DATE NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "from_account_id" TEXT,
    "to_account_id" TEXT,
    "category_account_id" TEXT,
    "tax_rate_id" TEXT,
    "tax_cents" INTEGER NOT NULL DEFAULT 0,
    "tax_creditable" BOOLEAN NOT NULL DEFAULT false,
    "document_number" TEXT,
    "memo" TEXT,
    "client_key" TEXT NOT NULL,
    "entry_id" TEXT NOT NULL,
    "voided_by_entry_id" TEXT,
    "replaces_transaction_id" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finance_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "finance_transactions_organization_id_occurred_on_idx" ON "finance_transactions"("organization_id", "occurred_on");

-- CreateIndex
CREATE INDEX "finance_transactions_organization_id_kind_occurred_on_idx" ON "finance_transactions"("organization_id", "kind", "occurred_on");

-- CreateIndex
CREATE UNIQUE INDEX "finance_transactions_organization_id_id_key" ON "finance_transactions"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "finance_transactions_organization_id_client_key_key" ON "finance_transactions"("organization_id", "client_key");

-- CreateIndex
CREATE UNIQUE INDEX "finance_transactions_organization_id_entry_id_key" ON "finance_transactions"("organization_id", "entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "finance_transactions_organization_id_voided_by_entry_id_key" ON "finance_transactions"("organization_id", "voided_by_entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "finance_transactions_organization_id_replaces_transaction_i_key" ON "finance_transactions"("organization_id", "replaces_transaction_id");

-- AddForeignKey
ALTER TABLE "finance_transactions" ADD CONSTRAINT "finance_transactions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_transactions" ADD CONSTRAINT "finance_transactions_organization_id_store_id_fkey" FOREIGN KEY ("organization_id", "store_id") REFERENCES "stores"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_transactions" ADD CONSTRAINT "finance_transactions_organization_id_from_account_id_fkey" FOREIGN KEY ("organization_id", "from_account_id") REFERENCES "ledger_accounts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_transactions" ADD CONSTRAINT "finance_transactions_organization_id_to_account_id_fkey" FOREIGN KEY ("organization_id", "to_account_id") REFERENCES "ledger_accounts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_transactions" ADD CONSTRAINT "finance_transactions_organization_id_category_account_id_fkey" FOREIGN KEY ("organization_id", "category_account_id") REFERENCES "ledger_accounts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_transactions" ADD CONSTRAINT "finance_transactions_organization_id_tax_rate_id_fkey" FOREIGN KEY ("organization_id", "tax_rate_id") REFERENCES "tax_rates"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_transactions" ADD CONSTRAINT "finance_transactions_organization_id_entry_id_fkey" FOREIGN KEY ("organization_id", "entry_id") REFERENCES "journal_entries"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_transactions" ADD CONSTRAINT "finance_transactions_organization_id_voided_by_entry_id_fkey" FOREIGN KEY ("organization_id", "voided_by_entry_id") REFERENCES "journal_entries"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_transactions" ADD CONSTRAINT "finance_transactions_organization_id_replaces_transaction__fkey" FOREIGN KEY ("organization_id", "replaces_transaction_id") REFERENCES "finance_transactions"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================================================
-- Step 4B.4 (TDD_18 §2.6, §4.3): what a person registers by hand. The rules below are the net under the service that
-- writes the table (the only one, through the posting service): the shape of each kind, the accounts it may name and the entry
-- it belongs to, whoever writes. A transaction is never edited and never deleted: the only change it takes is the pointer to
-- the entry that voids it, once.
-- ============================================================================================================
ALTER TABLE finance_transactions
  ADD CONSTRAINT chk_finance_transactions_kind CHECK (kind IN ('expense', 'income', 'transfer')),
  ADD CONSTRAINT chk_finance_transactions_amount CHECK (amount_cents > 0),
  ADD CONSTRAINT chk_finance_transactions_tax CHECK (tax_cents >= 0 AND tax_cents < amount_cents),
  ADD CONSTRAINT chk_finance_transactions_tax_rate CHECK (tax_cents = 0 OR tax_rate_id IS NOT NULL),
  ADD CONSTRAINT chk_finance_transactions_creditable CHECK (NOT tax_creditable OR (kind = 'expense' AND tax_rate_id IS NOT NULL)),
  ADD CONSTRAINT chk_finance_transactions_shape CHECK (
    (kind = 'expense' AND from_account_id IS NOT NULL AND to_account_id IS NULL AND category_account_id IS NOT NULL)
    OR (kind = 'income' AND to_account_id IS NOT NULL AND from_account_id IS NULL AND category_account_id IS NOT NULL)
    OR (kind = 'transfer' AND from_account_id IS NOT NULL AND to_account_id IS NOT NULL AND from_account_id <> to_account_id
        AND category_account_id IS NULL AND tax_rate_id IS NULL AND tax_cents = 0 AND NOT tax_creditable)
  ),
  ADD CONSTRAINT chk_finance_transactions_client_key CHECK (char_length(client_key) BETWEEN 1 AND 200),
  ADD CONSTRAINT chk_finance_transactions_memo CHECK (memo IS NULL OR char_length(memo) BETWEEN 1 AND 500),
  ADD CONSTRAINT chk_finance_transactions_document CHECK (document_number IS NULL OR char_length(document_number) BETWEEN 1 AND 100),
  ADD CONSTRAINT chk_finance_transactions_replaces CHECK (replaces_transaction_id IS NULL OR replaces_transaction_id <> id),
  ADD CONSTRAINT chk_finance_transactions_void CHECK (voided_by_entry_id IS NULL OR voided_by_entry_id <> entry_id);

-- The accounts a transaction names and the entry it belongs to (raised as the typed prefix the service maps)
CREATE FUNCTION check_finance_transaction_row() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
DECLARE
  moved_from ledger_accounts%ROWTYPE;
  moved_to ledger_accounts%ROWTYPE;
  category ledger_accounts%ROWTYPE;
  posted journal_entries%ROWTYPE;
  voiding journal_entries%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
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

  -- UPDATE: the pointer to the voiding entry is set once, to the reversal of this transaction's entry, and nothing else moves
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

CREATE TRIGGER trg_finance_transactions_check
BEFORE INSERT OR UPDATE ON finance_transactions
FOR EACH ROW EXECUTE FUNCTION check_finance_transaction_row();

CREATE FUNCTION forbid_finance_transaction_removal() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'FINANCE_TRANSACTION_IMMUTABLE: a transaction is voided, never deleted';
END $$;

CREATE TRIGGER trg_finance_transactions_no_delete
BEFORE DELETE ON finance_transactions
FOR EACH ROW EXECUTE FUNCTION forbid_finance_transaction_removal();

CREATE TRIGGER trg_finance_transactions_no_truncate
BEFORE TRUNCATE ON finance_transactions
FOR EACH STATEMENT EXECUTE FUNCTION forbid_finance_transaction_removal();

-- The application roles may add a transaction and point it at the entry that voids it: no other column is theirs to change
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE finance_transactions FROM platform_app, platform_worker;
GRANT UPDATE (voided_by_entry_id) ON TABLE finance_transactions TO platform_app, platform_worker;
