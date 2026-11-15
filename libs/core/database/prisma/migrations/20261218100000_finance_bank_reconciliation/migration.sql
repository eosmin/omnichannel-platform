-- CreateTable
CREATE TABLE "bank_import_profiles" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "delimiter" TEXT NOT NULL DEFAULT ',',
    "has_header" BOOLEAN NOT NULL DEFAULT true,
    "decimal_separator" TEXT NOT NULL DEFAULT '.',
    "thousands_separator" TEXT NOT NULL DEFAULT 'none',
    "date_format" TEXT NOT NULL DEFAULT 'yyyy-MM-dd',
    "encoding" TEXT NOT NULL DEFAULT 'utf-8',
    "date_window_days" INTEGER NOT NULL DEFAULT 3,
    "columns" JSONB NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bank_import_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_statement_imports" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "profile_id" TEXT,
    "media_id" TEXT NOT NULL,
    "line_count" INTEGER NOT NULL,
    "new_line_count" INTEGER NOT NULL,
    "first_day" DATE NOT NULL,
    "last_day" DATE NOT NULL,
    "closing_balance_cents" INTEGER,
    "closing_on" DATE,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_statement_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_statement_lines" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "import_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "line_no" INTEGER NOT NULL,
    "posted_on" DATE NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "description" TEXT,
    "reference" TEXT,
    "line_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_statement_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_matches" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "statement_line_id" TEXT NOT NULL,
    "journal_line_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "decided_by" TEXT NOT NULL,
    "decided_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "undone_by" TEXT,
    "undone_at" TIMESTAMP(3),

    CONSTRAINT "reconciliation_matches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "bank_import_profiles_organization_id_account_id_name_key" ON "bank_import_profiles"("organization_id", "account_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "bank_import_profiles_organization_id_id_key" ON "bank_import_profiles"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "bank_statement_imports_media_id_key" ON "bank_statement_imports"("media_id");

-- CreateIndex
CREATE INDEX "bank_statement_imports_organization_id_account_id_created_a_idx" ON "bank_statement_imports"("organization_id", "account_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "bank_statement_imports_organization_id_id_key" ON "bank_statement_imports"("organization_id", "id");

-- CreateIndex
CREATE INDEX "bank_statement_lines_import_id_line_no_idx" ON "bank_statement_lines"("import_id", "line_no");

-- CreateIndex
CREATE INDEX "bank_statement_lines_organization_id_account_id_posted_on_idx" ON "bank_statement_lines"("organization_id", "account_id", "posted_on");

-- CreateIndex
CREATE UNIQUE INDEX "bank_statement_lines_organization_id_account_id_line_hash_key" ON "bank_statement_lines"("organization_id", "account_id", "line_hash");

-- CreateIndex
CREATE UNIQUE INDEX "bank_statement_lines_organization_id_id_key" ON "bank_statement_lines"("organization_id", "id");

-- CreateIndex
CREATE INDEX "reconciliation_matches_organization_id_statement_line_id_idx" ON "reconciliation_matches"("organization_id", "statement_line_id");

-- CreateIndex
CREATE INDEX "reconciliation_matches_journal_line_id_idx" ON "reconciliation_matches"("journal_line_id");

-- AddForeignKey
ALTER TABLE "bank_import_profiles" ADD CONSTRAINT "bank_import_profiles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_import_profiles" ADD CONSTRAINT "bank_import_profiles_organization_id_account_id_fkey" FOREIGN KEY ("organization_id", "account_id") REFERENCES "ledger_accounts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_statement_imports" ADD CONSTRAINT "bank_statement_imports_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_statement_imports" ADD CONSTRAINT "bank_statement_imports_organization_id_account_id_fkey" FOREIGN KEY ("organization_id", "account_id") REFERENCES "ledger_accounts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_statement_imports" ADD CONSTRAINT "bank_statement_imports_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "media"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_organization_id_account_id_fkey" FOREIGN KEY ("organization_id", "account_id") REFERENCES "ledger_accounts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_organization_id_import_id_fkey" FOREIGN KEY ("organization_id", "import_id") REFERENCES "bank_statement_imports"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_matches" ADD CONSTRAINT "reconciliation_matches_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_matches" ADD CONSTRAINT "reconciliation_matches_organization_id_statement_line_id_fkey" FOREIGN KEY ("organization_id", "statement_line_id") REFERENCES "bank_statement_lines"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_matches" ADD CONSTRAINT "reconciliation_matches_journal_line_id_fkey" FOREIGN KEY ("journal_line_id") REFERENCES "journal_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================================================
-- Step 4B.4b-2 (TDD_18 §2.7, §4.4): bank reconciliation by CSV. What the database holds whoever writes (the service says it first, with the
-- typed answers; these are the net): the shape of a profile, an import and its lines that never change, and a match that only a person's
-- decision creates and that never edits the journal.
-- ============================================================================================================
ALTER TABLE bank_import_profiles
  ADD CONSTRAINT chk_bank_profiles_delimiter CHECK (delimiter IN (',', ';', E'\t')),
  ADD CONSTRAINT chk_bank_profiles_decimal CHECK (decimal_separator IN ('.', ',')),
  ADD CONSTRAINT chk_bank_profiles_thousands CHECK (thousands_separator IN ('none', 'comma', 'dot', 'space')),
  ADD CONSTRAINT chk_bank_profiles_date_format CHECK (date_format IN ('yyyy-MM-dd', 'dd/MM/yyyy', 'MM/dd/yyyy', 'dd-MM-yyyy')),
  ADD CONSTRAINT chk_bank_profiles_encoding CHECK (encoding IN ('utf-8', 'windows-1252')),
  ADD CONSTRAINT chk_bank_profiles_window CHECK (date_window_days BETWEEN 0 AND 31),
  ADD CONSTRAINT chk_bank_profiles_separators CHECK (
    delimiter <> decimal_separator
    AND NOT (thousands_separator = 'comma' AND decimal_separator = ',')
    AND NOT (thousands_separator = 'dot' AND decimal_separator = '.')
    AND NOT (thousands_separator = 'comma' AND delimiter = ',')
  ),
  ADD CONSTRAINT chk_bank_profiles_name CHECK (char_length(name) BETWEEN 1 AND 80),
  ADD CONSTRAINT chk_bank_profiles_columns CHECK (jsonb_typeof(columns) = 'object');

ALTER TABLE bank_statement_imports
  ADD CONSTRAINT chk_bank_imports_counts CHECK (line_count > 0 AND new_line_count BETWEEN 0 AND line_count),
  ADD CONSTRAINT chk_bank_imports_days CHECK (first_day <= last_day),
  ADD CONSTRAINT chk_bank_imports_closing CHECK ((closing_balance_cents IS NULL) = (closing_on IS NULL));

ALTER TABLE bank_statement_lines
  ADD CONSTRAINT chk_bank_lines_amount CHECK (amount_cents <> 0),
  ADD CONSTRAINT chk_bank_lines_hash CHECK (line_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT chk_bank_lines_line_no CHECK (line_no >= 1);

ALTER TABLE reconciliation_matches
  ADD CONSTRAINT chk_reconciliation_status CHECK (status IN ('confirmed', 'rejected', 'undone')),
  ADD CONSTRAINT chk_reconciliation_undone CHECK ((status = 'undone') = (undone_at IS NOT NULL AND undone_by IS NOT NULL));

-- At most one confirmed match per statement line and per journal line (the same movement is never reconciled twice), and a pair is
-- rejected once
CREATE UNIQUE INDEX uq_reconciliation_confirmed_statement_line ON reconciliation_matches (statement_line_id) WHERE status = 'confirmed';
CREATE UNIQUE INDEX uq_reconciliation_confirmed_journal_line ON reconciliation_matches (journal_line_id) WHERE status = 'confirmed';
CREATE UNIQUE INDEX uq_reconciliation_rejected_pair ON reconciliation_matches (statement_line_id, journal_line_id) WHERE status = 'rejected';

-- A profile reads the file of one cash, bank or wallet account of its organization, and keeps that account
CREATE FUNCTION check_bank_profile_row() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
DECLARE
  kind text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.account_id IS DISTINCT FROM OLD.account_id THEN
    RAISE EXCEPTION 'BANK_PROFILE: a profile keeps its account';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT cash_kind INTO kind FROM ledger_accounts WHERE id = NEW.account_id AND organization_id = NEW.organization_id;
    IF kind IS NULL THEN
      RAISE EXCEPTION 'BANK_PROFILE: the account is not a cash, bank or wallet account of the organization';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_bank_profiles_check
BEFORE INSERT OR UPDATE ON bank_import_profiles
FOR EACH ROW EXECUTE FUNCTION check_bank_profile_row();

-- An import: a cash-kind account of the organization, and the file is a finance file of a store of the SAME organization that is no
-- receipt of a transaction
CREATE FUNCTION check_bank_import_row() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
DECLARE
  kind text;
  file media%ROWTYPE;
  file_org text;
BEGIN
  SELECT cash_kind INTO kind FROM ledger_accounts WHERE id = NEW.account_id AND organization_id = NEW.organization_id;
  IF kind IS NULL THEN
    RAISE EXCEPTION 'BANK_IMPORT: the account is not a cash, bank or wallet account of the organization';
  END IF;
  SELECT * INTO file FROM media WHERE id = NEW.media_id;
  SELECT organization_id INTO file_org FROM stores WHERE id = file.store_id;
  IF file.id IS NULL
     OR file.purpose IS DISTINCT FROM 'finance_document'
     OR file.finance_transaction_id IS NOT NULL
     OR file_org IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'BANK_IMPORT: the file is not a finance file of the organization';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_bank_imports_check
BEFORE INSERT ON bank_statement_imports
FOR EACH ROW EXECUTE FUNCTION check_bank_import_row();

-- A line belongs to the account of the import it came with
CREATE FUNCTION check_bank_line_row() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
DECLARE
  brought bank_statement_imports%ROWTYPE;
BEGIN
  SELECT * INTO brought FROM bank_statement_imports WHERE id = NEW.import_id AND organization_id = NEW.organization_id;
  IF brought.id IS NULL OR brought.account_id IS DISTINCT FROM NEW.account_id THEN
    RAISE EXCEPTION 'BANK_LINE: the line is not of the account of its import';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_bank_lines_check
BEFORE INSERT ON bank_statement_lines
FOR EACH ROW EXECUTE FUNCTION check_bank_line_row();

-- An import and its lines are evidence of what the bank said: they are never changed or removed
CREATE FUNCTION forbid_bank_statement_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'BANK_STATEMENT_IMMUTABLE: an imported statement is never changed or removed';
END $$;

CREATE TRIGGER trg_bank_imports_immutable
BEFORE UPDATE OR DELETE ON bank_statement_imports
FOR EACH ROW EXECUTE FUNCTION forbid_bank_statement_change();
CREATE TRIGGER trg_bank_imports_no_truncate
BEFORE TRUNCATE ON bank_statement_imports
FOR EACH STATEMENT EXECUTE FUNCTION forbid_bank_statement_change();
CREATE TRIGGER trg_bank_lines_immutable
BEFORE UPDATE OR DELETE ON bank_statement_lines
FOR EACH ROW EXECUTE FUNCTION forbid_bank_statement_change();
CREATE TRIGGER trg_bank_lines_no_truncate
BEFORE TRUNCATE ON bank_statement_lines
FOR EACH STATEMENT EXECUTE FUNCTION forbid_bank_statement_change();

-- A decision. It names a statement line and a line of the journal of the SAME organization and the SAME account. A confirmed one is the
-- same movement: the same amount in the same direction (debit minus credit equals the statement's signed amount), and the journal line
-- belongs to an entry that nothing reversed and that is no reversal (a voided transaction never reached the bank). It is changed only
-- once, from confirmed or rejected to undone, with who and when; never deleted.
CREATE FUNCTION check_reconciliation_match_row() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
DECLARE
  statement bank_statement_lines%ROWTYPE;
  book journal_lines%ROWTYPE;
  book_entry journal_entries%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'undone' THEN
      RAISE EXCEPTION 'RECONCILIATION_MATCH: a decision is born confirmed or rejected';
    END IF;
    SELECT * INTO statement FROM bank_statement_lines WHERE id = NEW.statement_line_id AND organization_id = NEW.organization_id;
    SELECT * INTO book FROM journal_lines WHERE id = NEW.journal_line_id AND organization_id = NEW.organization_id;
    IF statement.id IS NULL OR book.id IS NULL OR statement.account_id IS DISTINCT FROM book.account_id THEN
      RAISE EXCEPTION 'RECONCILIATION_MATCH: the lines are not of the same account of the organization';
    END IF;
    IF NEW.status = 'confirmed' THEN
      IF statement.amount_cents IS DISTINCT FROM (book.debit_cents - book.credit_cents) THEN
        RAISE EXCEPTION 'RECONCILIATION_MATCH: the amounts are not the same movement';
      END IF;
      -- A confirmation and the reversal of the same entry take turns (the reversal takes the same lock below): whichever comes second sees
      -- the other, so a match on a reversed entry cannot be made by a race
      PERFORM pg_advisory_xact_lock(hashtextextended('finance_entry:' || book.entry_id, 0));
      SELECT * INTO book_entry FROM journal_entries WHERE id = book.entry_id AND organization_id = NEW.organization_id;
      IF book_entry.reverses_entry_id IS NOT NULL
         OR EXISTS (SELECT 1 FROM journal_entries WHERE reverses_entry_id = book_entry.id AND organization_id = NEW.organization_id) THEN
        RAISE EXCEPTION 'RECONCILIATION_MATCH: a reversed entry and its reversal are never matched with the bank';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE: a decision is taken back once and nothing else moves
  IF OLD.status = 'undone'
     OR NEW.status <> 'undone'
     OR (to_jsonb(NEW) - 'status' - 'undone_by' - 'undone_at') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'undone_by' - 'undone_at') THEN
    RAISE EXCEPTION 'RECONCILIATION_MATCH: a decision is only taken back, once';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_reconciliation_matches_check
BEFORE INSERT OR UPDATE ON reconciliation_matches
FOR EACH ROW EXECUTE FUNCTION check_reconciliation_match_row();

CREATE FUNCTION forbid_reconciliation_match_removal() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'RECONCILIATION_MATCH: a decision is taken back (undone), never deleted';
END $$;

CREATE TRIGGER trg_reconciliation_matches_no_delete
BEFORE DELETE ON reconciliation_matches
FOR EACH ROW EXECUTE FUNCTION forbid_reconciliation_match_removal();
CREATE TRIGGER trg_reconciliation_matches_no_truncate
BEFORE TRUNCATE ON reconciliation_matches
FOR EACH STATEMENT EXECUTE FUNCTION forbid_reconciliation_match_removal();

-- The application roles add rows; the one change they may make is to take a decision back; nothing is deleted (a profile is a
-- setting and keeps its ordinary privileges)
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE bank_statement_imports, bank_statement_lines, reconciliation_matches FROM platform_app, platform_worker;
GRANT UPDATE (status, undone_by, undone_at) ON TABLE reconciliation_matches TO platform_app, platform_worker;

-- The other half of the rule: an entry that a confirmed match names is not reversed (voiding its transaction posts a reversal too). The
-- service says it first with FINANCE_ENTRY_RECONCILED; this is the net, under the lock that a confirmation takes.
CREATE FUNCTION forbid_reversal_of_reconciled_entry() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('finance_entry:' || NEW.reverses_entry_id, 0));
  IF EXISTS (
    SELECT 1
    FROM reconciliation_matches m
    JOIN journal_lines l ON l.id = m.journal_line_id
    WHERE m.status = 'confirmed' AND l.entry_id = NEW.reverses_entry_id
  ) THEN
    RAISE EXCEPTION 'FINANCE_ENTRY_RECONCILED: the entry is reconciled with a bank statement: take the match back first';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_journal_entries_reconciled
BEFORE INSERT ON journal_entries
FOR EACH ROW WHEN (NEW.reverses_entry_id IS NOT NULL)
EXECUTE FUNCTION forbid_reversal_of_reconciled_entry();
