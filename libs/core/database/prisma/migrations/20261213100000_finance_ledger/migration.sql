-- Step 4B.2 (TDD_18 §2): the double-entry ledger of the organization. The tables come first (the part Prisma generates),
-- then what Prisma cannot say: the CHECKs, the append-only triggers, the balanced-entry constraint, the open-period and
-- postable-account checks, the gapless number and the head of the hash chain, and the privileges. Everything is new, so
-- nothing is migrated and nothing can fail on old rows.

-- CreateTable
CREATE TABLE "finance_settings" (
    "organization_id" TEXT NOT NULL,
    "country_code" TEXT NOT NULL,
    "base_currency" TEXT NOT NULL DEFAULT 'USD',
    "accounting_start_date" DATE NOT NULL,
    "locked_through" DATE,
    "next_entry_number" BIGINT NOT NULL DEFAULT 1,
    "last_entry_hash" TEXT,
    "recognize_sale_on" TEXT NOT NULL DEFAULT 'delivered',
    "rounding_account_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "finance_settings_pkey" PRIMARY KEY ("organization_id")
);

-- CreateTable
CREATE TABLE "ledger_accounts" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "store_id" TEXT,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "normal_side" TEXT NOT NULL,
    "parent_id" TEXT,
    "is_postable" BOOLEAN NOT NULL DEFAULT true,
    "cash_kind" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ledger_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_role_mappings" (
    "organization_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,

    CONSTRAINT "account_role_mappings_pkey" PRIMARY KEY ("organization_id","role")
);

-- CreateTable
CREATE TABLE "payment_method_accounts" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "store_id" TEXT,
    "payment_method" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,

    CONSTRAINT "payment_method_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fiscal_periods" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "starts_on" DATE NOT NULL,
    "ends_on" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "closed_at" TIMESTAMP(3),
    "closed_by" TEXT,
    "reopened_at" TIMESTAMP(3),
    "reopened_by" TEXT,
    "reopen_reason" TEXT,
    "closing_hash" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fiscal_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_entries" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "number" BIGINT NOT NULL,
    "entry_date" DATE NOT NULL,
    "period_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "source_type" TEXT,
    "source_id" TEXT,
    "source_date" DATE,
    "idempotency_key" TEXT NOT NULL,
    "reverses_entry_id" TEXT,
    "memo" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "total_cents" INTEGER NOT NULL,
    "created_by" TEXT,
    "origin" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "prev_hash" TEXT,
    "hash" TEXT NOT NULL,

    CONSTRAINT "journal_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_lines" (
    "id" TEXT NOT NULL,
    "entry_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "store_id" TEXT,
    "account_id" TEXT NOT NULL,
    "debit_cents" INTEGER NOT NULL DEFAULT 0,
    "credit_cents" INTEGER NOT NULL DEFAULT 0,
    "party_type" TEXT,
    "party_id" TEXT,
    "tax_rate_id" TEXT,
    "memo" TEXT,
    "line_no" INTEGER NOT NULL,

    CONSTRAINT "journal_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_period_balances" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "store_id" TEXT,
    "period_id" TEXT NOT NULL,
    "debit_cents" BIGINT NOT NULL DEFAULT 0,
    "credit_cents" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_period_balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finance_posting_failures" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "event_kind" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "finance_posting_failures_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ledger_accounts_organization_id_type_idx" ON "ledger_accounts"("organization_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_accounts_organization_id_code_key" ON "ledger_accounts"("organization_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_accounts_organization_id_id_key" ON "ledger_accounts"("organization_id", "id");

-- CreateIndex
CREATE INDEX "account_role_mappings_account_id_idx" ON "account_role_mappings"("account_id");

-- CreateIndex
CREATE INDEX "payment_method_accounts_account_id_idx" ON "payment_method_accounts"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_method_accounts_organization_id_store_id_payment_me_key" ON "payment_method_accounts"("organization_id", "store_id", "payment_method");

-- CreateIndex
CREATE UNIQUE INDEX "fiscal_periods_organization_id_year_month_key" ON "fiscal_periods"("organization_id", "year", "month");

-- CreateIndex
CREATE UNIQUE INDEX "fiscal_periods_organization_id_id_key" ON "fiscal_periods"("organization_id", "id");

-- CreateIndex
CREATE INDEX "journal_entries_organization_id_period_id_idx" ON "journal_entries"("organization_id", "period_id");

-- CreateIndex
CREATE INDEX "journal_entries_organization_id_source_type_source_id_idx" ON "journal_entries"("organization_id", "source_type", "source_id");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_organization_id_number_key" ON "journal_entries"("organization_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_organization_id_idempotency_key_key" ON "journal_entries"("organization_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_organization_id_id_key" ON "journal_entries"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_organization_id_reverses_entry_id_key" ON "journal_entries"("organization_id", "reverses_entry_id");

-- CreateIndex
CREATE INDEX "journal_lines_organization_id_account_id_idx" ON "journal_lines"("organization_id", "account_id");

-- CreateIndex
-- CreateIndex
CREATE INDEX "journal_lines_store_id_idx" ON "journal_lines"("store_id");

-- CreateIndex
CREATE UNIQUE INDEX "journal_lines_entry_id_line_no_key" ON "journal_lines"("entry_id", "line_no");

-- CreateIndex
CREATE INDEX "account_period_balances_organization_id_period_id_idx" ON "account_period_balances"("organization_id", "period_id");

-- CreateIndex
CREATE INDEX "account_period_balances_account_id_idx" ON "account_period_balances"("account_id");

-- CreateIndex
CREATE INDEX "finance_posting_failures_organization_id_resolved_at_idx" ON "finance_posting_failures"("organization_id", "resolved_at");

-- CreateIndex
CREATE UNIQUE INDEX "finance_posting_failures_organization_id_source_type_source_key" ON "finance_posting_failures"("organization_id", "source_type", "source_id", "event_kind");

-- AddForeignKey
ALTER TABLE "finance_settings" ADD CONSTRAINT "finance_settings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_settings" ADD CONSTRAINT "finance_settings_organization_id_rounding_account_id_fkey" FOREIGN KEY ("organization_id", "rounding_account_id") REFERENCES "ledger_accounts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_organization_id_parent_id_fkey" FOREIGN KEY ("organization_id", "parent_id") REFERENCES "ledger_accounts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_role_mappings" ADD CONSTRAINT "account_role_mappings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_role_mappings" ADD CONSTRAINT "account_role_mappings_organization_id_account_id_fkey" FOREIGN KEY ("organization_id", "account_id") REFERENCES "ledger_accounts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_method_accounts" ADD CONSTRAINT "payment_method_accounts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_method_accounts" ADD CONSTRAINT "payment_method_accounts_organization_id_store_id_fkey" FOREIGN KEY ("organization_id", "store_id") REFERENCES "stores"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_method_accounts" ADD CONSTRAINT "payment_method_accounts_organization_id_account_id_fkey" FOREIGN KEY ("organization_id", "account_id") REFERENCES "ledger_accounts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fiscal_periods" ADD CONSTRAINT "fiscal_periods_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_organization_id_period_id_fkey" FOREIGN KEY ("organization_id", "period_id") REFERENCES "fiscal_periods"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_organization_id_reverses_entry_id_fkey" FOREIGN KEY ("organization_id", "reverses_entry_id") REFERENCES "journal_entries"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_organization_id_entry_id_fkey" FOREIGN KEY ("organization_id", "entry_id") REFERENCES "journal_entries"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_organization_id_account_id_fkey" FOREIGN KEY ("organization_id", "account_id") REFERENCES "ledger_accounts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_organization_id_store_id_fkey" FOREIGN KEY ("organization_id", "store_id") REFERENCES "stores"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_period_balances" ADD CONSTRAINT "account_period_balances_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_period_balances" ADD CONSTRAINT "account_period_balances_organization_id_account_id_fkey" FOREIGN KEY ("organization_id", "account_id") REFERENCES "ledger_accounts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_period_balances" ADD CONSTRAINT "account_period_balances_organization_id_period_id_fkey" FOREIGN KEY ("organization_id", "period_id") REFERENCES "fiscal_periods"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_period_balances" ADD CONSTRAINT "account_period_balances_organization_id_store_id_fkey" FOREIGN KEY ("organization_id", "store_id") REFERENCES "stores"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_posting_failures" ADD CONSTRAINT "finance_posting_failures_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ============================================================================================================
-- CHECKs: the shape the books stand on, whoever writes (the application, a script, a person with a console)
-- ============================================================================================================
ALTER TABLE finance_settings
  ADD CONSTRAINT chk_finance_settings_currency CHECK (base_currency = 'USD'),
  ADD CONSTRAINT chk_finance_settings_country CHECK (country_code ~ '^[A-Z]{2}$'),
  ADD CONSTRAINT chk_finance_settings_recognize CHECK (recognize_sale_on IN ('delivered', 'shipped')),
  ADD CONSTRAINT chk_finance_settings_next_number CHECK (next_entry_number >= 1),
  -- The head of the chain and the counter agree: no entry yet means no hash, and the first number is 1
  ADD CONSTRAINT chk_finance_settings_head CHECK ((next_entry_number = 1) = (last_entry_hash IS NULL));

ALTER TABLE ledger_accounts
  -- Accounts per store are Phase 2 (TDD_18 §2.2): dropping this CHECK is the whole change
  ADD CONSTRAINT chk_ledger_accounts_org_wide CHECK (store_id IS NULL),
  ADD CONSTRAINT chk_ledger_accounts_currency CHECK (currency = 'USD'),
  ADD CONSTRAINT chk_ledger_accounts_type CHECK (type IN ('asset', 'liability', 'equity', 'income', 'cost_of_sales', 'expense')),
  ADD CONSTRAINT chk_ledger_accounts_normal_side CHECK (
    (type IN ('asset', 'cost_of_sales', 'expense') AND normal_side = 'debit')
    OR (type IN ('liability', 'equity', 'income') AND normal_side = 'credit')
  ),
  -- Cash, a bank account or a wallet is an asset that takes entries
  ADD CONSTRAINT chk_ledger_accounts_cash_kind CHECK (
    cash_kind IS NULL OR (cash_kind IN ('cash', 'bank', 'wallet') AND type = 'asset' AND is_postable)
  ),
  -- Codes are printed on documents: ASCII letters and digits with . _ - inside. A name has no control character and no
  -- stray space (the same rules as a warehouse's)
  ADD CONSTRAINT chk_ledger_accounts_code CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$'),
  ADD CONSTRAINT chk_ledger_accounts_name CHECK (
    name = btrim(name) AND char_length(name) BETWEEN 1 AND 150 AND name !~ '[[:cntrl:]]'
  ),
  ADD CONSTRAINT chk_ledger_accounts_not_own_parent CHECK (parent_id IS NULL OR parent_id <> id);
-- A code is one whatever its case, like a warehouse's
CREATE UNIQUE INDEX uq_ledger_accounts_code_lower ON ledger_accounts (organization_id, lower(code));

-- The default account of a payment method is one per organization (a NULL store is never equal to another in a unique
-- index, so the key Prisma declares cannot say it), and a store's own account is one per store
CREATE UNIQUE INDEX uq_payment_method_accounts_default ON payment_method_accounts (organization_id, payment_method) WHERE store_id IS NULL;
ALTER TABLE payment_method_accounts
  -- What the carrier collects never lands in a cash or bank account directly (TDD_18 §6.2)
  ADD CONSTRAINT chk_payment_method_accounts_method CHECK (payment_method <> 'CASH_ON_DELIVERY');

ALTER TABLE fiscal_periods
  ADD CONSTRAINT chk_fiscal_periods_month CHECK (month BETWEEN 1 AND 12 AND year BETWEEN 2000 AND 2200),
  -- Calendar months (TDD_18 §2.4); a fiscal year that is not the calendar year is a template setting later
  ADD CONSTRAINT chk_fiscal_periods_bounds CHECK (
    starts_on = make_date(year, month, 1) AND ends_on = (make_date(year, month, 1) + INTERVAL '1 month - 1 day')::date
  ),
  ADD CONSTRAINT chk_fiscal_periods_status CHECK (status IN ('open', 'closed')),
  ADD CONSTRAINT chk_fiscal_periods_closed CHECK (status = 'open' OR (closed_at IS NOT NULL AND closed_by IS NOT NULL));

ALTER TABLE journal_entries
  ADD CONSTRAINT chk_journal_entries_currency CHECK (currency = 'USD'),
  ADD CONSTRAINT chk_journal_entries_number CHECK (number >= 1),
  ADD CONSTRAINT chk_journal_entries_total CHECK (total_cents > 0),
  ADD CONSTRAINT chk_journal_entries_origin CHECK (origin IN ('user', 'system')),
  -- A person's entry says whose it is; the system's has no user
  ADD CONSTRAINT chk_journal_entries_author CHECK ((origin = 'user') = (created_by IS NOT NULL)),
  -- The first entry has no predecessor and every other one has
  ADD CONSTRAINT chk_journal_entries_chain CHECK ((number = 1) = (prev_hash IS NULL)),
  ADD CONSTRAINT chk_journal_entries_hash CHECK (hash ~ '^[0-9a-f]{64}$' AND (prev_hash IS NULL OR prev_hash ~ '^[0-9a-f]{64}$')),
  -- Only a reversal points at an entry, and never at itself
  ADD CONSTRAINT chk_journal_entries_reversal CHECK ((type = 'reversal') = (reverses_entry_id IS NOT NULL) AND reverses_entry_id IS DISTINCT FROM id),
  -- Every entry has a source or is manual, and a source has its id
  ADD CONSTRAINT chk_journal_entries_source CHECK ((source_type IS NULL) = (source_id IS NULL)),
  ADD CONSTRAINT chk_journal_entries_key CHECK (char_length(idempotency_key) BETWEEN 1 AND 200);

ALTER TABLE journal_lines
  -- Exactly one side per line, and it is positive
  ADD CONSTRAINT chk_journal_lines_one_side CHECK (debit_cents >= 0 AND credit_cents >= 0 AND (debit_cents > 0) <> (credit_cents > 0)),
  ADD CONSTRAINT chk_journal_lines_line_no CHECK (line_no >= 1),
  ADD CONSTRAINT chk_journal_lines_party CHECK ((party_type IS NULL) = (party_id IS NULL) AND (party_type IS NULL OR party_type IN ('supplier', 'carrier_connection', 'customer')));

ALTER TABLE account_period_balances
  ADD CONSTRAINT chk_account_period_balances_sums CHECK (debit_cents >= 0 AND credit_cents >= 0);
-- One row per account, period and store, a null store being one (Prisma cannot declare these)
CREATE UNIQUE INDEX uq_account_period_balances_store ON account_period_balances (organization_id, account_id, period_id, store_id) WHERE store_id IS NOT NULL;
CREATE UNIQUE INDEX uq_account_period_balances_no_store ON account_period_balances (organization_id, account_id, period_id) WHERE store_id IS NULL;

ALTER TABLE finance_posting_failures
  ADD CONSTRAINT chk_finance_posting_failures_attempts CHECK (attempts >= 1);

-- ============================================================================================================
-- The journal is append-only (TDD_18 §2.5): no UPDATE, DELETE or TRUNCATE of an entry or of a line, by the application
-- (the privileges) and by anyone else (the triggers, which refuse the owner of the table too). The security suite checks
-- both, so a later GRANT ... ON ALL TABLES that gives the privileges back fails the build.
-- ============================================================================================================
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE journal_entries, journal_lines FROM platform_app, platform_worker;
REVOKE TRUNCATE ON TABLE finance_settings, ledger_accounts, account_role_mappings, payment_method_accounts, fiscal_periods, account_period_balances, finance_posting_failures FROM platform_app, platform_worker;

CREATE FUNCTION forbid_journal_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'FINANCE_LEDGER_IMMUTABLE: % of % is not allowed, the journal is append-only (reverse the entry instead)', TG_OP, TG_TABLE_NAME;
END $$;

CREATE TRIGGER trg_journal_entries_append_only BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_journal_change();
CREATE TRIGGER trg_journal_entries_no_truncate BEFORE TRUNCATE ON journal_entries
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_journal_change();
CREATE TRIGGER trg_journal_lines_append_only BEFORE UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION forbid_journal_change();
CREATE TRIGGER trg_journal_lines_no_truncate BEFORE TRUNCATE ON journal_lines
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_journal_change();

-- ============================================================================================================
-- An entry is written into an open period, on the next number, after the entry that holds the head of the chain
-- ============================================================================================================
CREATE FUNCTION check_journal_entry_insert() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
DECLARE
  settings finance_settings%ROWTYPE;
  period fiscal_periods%ROWTYPE;
  head RECORD;
BEGIN
  -- Shared locks: the entry waits for a close that is in flight and sees it, and a close waits for the entry (the service takes the
  -- settings row for update first, so for it these are the locks it already holds)
  SELECT * INTO settings FROM finance_settings WHERE organization_id = NEW.organization_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FINANCE_SETUP_REQUIRED: the organization has no finance settings';
  END IF;
  SELECT * INTO period FROM fiscal_periods WHERE id = NEW.period_id AND organization_id = NEW.organization_id FOR SHARE;
  IF NOT FOUND OR NEW.entry_date < period.starts_on OR NEW.entry_date > period.ends_on THEN
    RAISE EXCEPTION 'FINANCE_ENTRY_PERIOD: the date of the entry is not in the period it names';
  END IF;
  -- The lock of the books (TDD_18 §5.2): the status of the period and the last day of the last closed one agree
  -- ... and it is read from the periods themselves too, so a period closed with a plain UPDATE locks everything up to its last day
  IF period.status <> 'open' OR (settings.locked_through IS NOT NULL AND NEW.entry_date <= settings.locked_through)
     OR EXISTS (SELECT 1 FROM fiscal_periods c WHERE c.organization_id = NEW.organization_id AND c.status = 'closed' AND c.ends_on >= NEW.entry_date) THEN
    RAISE EXCEPTION 'FINANCE_PERIOD_CLOSED: the period of the entry is closed';
  END IF;
  IF NEW.entry_date < settings.accounting_start_date THEN
    RAISE EXCEPTION 'FINANCE_BEFORE_START_DATE: the date is before the accounting start date';
  END IF;
  -- Gapless and chained (TDD_18 §2.5): the service takes the number and the head under a lock on finance_settings, and
  -- this is the net under it: a number that skips, repeats or points at another entry is refused
  SELECT e.number, e.hash INTO head FROM journal_entries e WHERE e.organization_id = NEW.organization_id ORDER BY e.number DESC LIMIT 1;
  IF NEW.number <> COALESCE(head.number, 0) + 1 THEN
    RAISE EXCEPTION 'FINANCE_ENTRY_NUMBER: the number of the entry must follow the last one (no gaps)';
  END IF;
  IF NEW.prev_hash IS DISTINCT FROM head.hash THEN
    RAISE EXCEPTION 'FINANCE_ENTRY_CHAIN: the entry does not point at the hash of the last one';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_journal_entries_insert BEFORE INSERT ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION check_journal_entry_insert();

-- The counter and the head of the chain move with the entry, in the same transaction, by this trigger and by nothing
-- else: they cannot drift from the journal whatever the application does
CREATE FUNCTION advance_finance_head() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE finance_settings SET next_entry_number = NEW.number + 1, last_entry_hash = NEW.hash WHERE organization_id = NEW.organization_id;
  RETURN NULL;
END $$;

CREATE TRIGGER trg_journal_entries_advance AFTER INSERT ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION advance_finance_head();

-- Only the trigger above (one level down) moves the counter and the head; a direct UPDATE cannot rewind or skip them
CREATE FUNCTION guard_finance_head() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  IF (NEW.next_entry_number IS DISTINCT FROM OLD.next_entry_number OR NEW.last_entry_hash IS DISTINCT FROM OLD.last_entry_hash)
     AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'FINANCE_ENTRY_NUMBER: the counter and the head of the chain move only with an entry';
  END IF;
  -- The lock of the books is the end of the last closed period, or nothing when none is closed (TDD_18 §5.2): the service
  -- closes or reopens the period first and moves the lock after it
  IF NEW.locked_through IS DISTINCT FROM OLD.locked_through
     AND NEW.locked_through IS DISTINCT FROM (
       SELECT max(p.ends_on) FROM fiscal_periods p WHERE p.organization_id = NEW.organization_id AND p.status = 'closed'
     ) THEN
    RAISE EXCEPTION 'FINANCE_PERIOD_CLOSED: the lock of the books is the end of the last closed period';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_finance_settings_head BEFORE UPDATE ON finance_settings
  FOR EACH ROW EXECUTE FUNCTION guard_finance_head();

-- ============================================================================================================
-- A line goes to an account that is active and takes entries, of an entry of an open period
-- ============================================================================================================
CREATE FUNCTION check_journal_line_insert() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
DECLARE
  account ledger_accounts%ROWTYPE;
  status text;
  entry_type text;
BEGIN
  SELECT * INTO account FROM ledger_accounts WHERE id = NEW.account_id AND organization_id = NEW.organization_id;
  IF NOT FOUND OR NOT account.is_postable THEN
    RAISE EXCEPTION 'FINANCE_ACCOUNT_NOT_POSTABLE: the account takes no entries';
  END IF;
  SELECT p.status, e.type INTO status, entry_type
    FROM journal_entries e JOIN fiscal_periods p ON p.id = e.period_id AND p.organization_id = e.organization_id
    WHERE e.id = NEW.entry_id AND e.organization_id = NEW.organization_id;
  -- An inactive account takes no new entries, but the correction of an entry that used it is a reversal (TDD_18 §2.5)
  IF NOT account.active AND entry_type IS DISTINCT FROM 'reversal' THEN
    RAISE EXCEPTION 'FINANCE_ACCOUNT_INACTIVE: the account is inactive';
  END IF;
  IF status IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'FINANCE_PERIOD_CLOSED: the period of the entry is closed';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_journal_lines_insert BEFORE INSERT ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION check_journal_line_insert();

-- ============================================================================================================
-- Balanced at commit (TDD_18 §2.5): the debits of an entry equal its credits, equal its total, and it has two lines at
-- least. Deferred, so the lines can be inserted one by one; it is checked once per line and once for the entry itself
-- (an entry inserted with no lines at all)
-- ============================================================================================================
CREATE FUNCTION check_journal_entry_balanced() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
DECLARE
  -- The same function serves both tables, and a record has only the fields of its own table: read it as json
  v_entry_id text := CASE TG_TABLE_NAME WHEN 'journal_entries' THEN to_jsonb(NEW)->>'id' ELSE to_jsonb(NEW)->>'entry_id' END;
  entry_total integer;
  debits bigint;
  credits bigint;
  line_count integer;
BEGIN
  SELECT e.total_cents INTO entry_total FROM journal_entries e WHERE e.id = v_entry_id;
  SELECT COALESCE(SUM(l.debit_cents), 0), COALESCE(SUM(l.credit_cents), 0), COUNT(*)
    INTO debits, credits, line_count FROM journal_lines l WHERE l.entry_id = v_entry_id;
  IF line_count < 2 OR debits <> credits OR debits <> entry_total THEN
    RAISE EXCEPTION 'FINANCE_ENTRY_UNBALANCED: entry % has % lines, debits %, credits %, total %', v_entry_id, line_count, debits, credits, entry_total
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER trg_journal_entries_balanced AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_journal_entry_balanced();
CREATE CONSTRAINT TRIGGER trg_journal_lines_balanced AFTER INSERT ON journal_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_journal_entry_balanced();

-- ============================================================================================================
-- The chart: an account with entries keeps its type and stays a postable account, and a system account is never deleted
-- (TDD_18 §2.3). Renaming and re-parenting stay allowed.
-- ============================================================================================================
CREATE FUNCTION guard_ledger_account_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.is_system THEN
      RAISE EXCEPTION 'FINANCE_SYSTEM_ACCOUNT: a system account cannot be deleted, only deactivated';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.organization_id <> OLD.organization_id THEN
    RAISE EXCEPTION 'FINANCE_TENANCY: an account does not change organization';
  END IF;
  -- The flag that makes an account undeletable cannot be taken off
  IF OLD.is_system AND NOT NEW.is_system THEN
    RAISE EXCEPTION 'FINANCE_SYSTEM_ACCOUNT: a system account stays a system account';
  END IF;
  IF NEW.type <> OLD.type AND EXISTS (SELECT 1 FROM journal_lines WHERE organization_id = OLD.organization_id AND account_id = OLD.id) THEN
    RAISE EXCEPTION 'FINANCE_ACCOUNT_TYPE_LOCKED: the type of an account with entries cannot change';
  END IF;
  IF OLD.is_postable AND NOT NEW.is_postable AND EXISTS (SELECT 1 FROM journal_lines WHERE organization_id = OLD.organization_id AND account_id = OLD.id) THEN
    RAISE EXCEPTION 'FINANCE_ACCOUNT_HAS_ENTRIES: an account with entries cannot become a header';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_ledger_accounts_guard BEFORE UPDATE OR DELETE ON ledger_accounts
  FOR EACH ROW EXECUTE FUNCTION guard_ledger_account_change();

-- ============================================================================================================
-- FINANCE_*, FISCAL_*: the Admin role of every store holds every permission (RolePresets), so the stores that exist get the
-- new ones as the ones made from now on do. No other role holds any (TDD_18 §9.1).
-- ============================================================================================================
INSERT INTO "permissions" ("id", "name", "role_id")
SELECT gen_random_uuid()::text, p.name, r."id"
FROM "roles" r
CROSS JOIN (VALUES
  ('finance:view'), ('finance:view_journal'), ('finance:manage_transactions'), ('finance:move_money'),
  ('finance:manage_purchases'), ('finance:reconcile'), ('finance:manage_accounts'), ('finance:post_manual'),
  ('finance:close_periods'), ('finance:export'), ('finance:view_carrier_fees'), ('fiscal:view'), ('fiscal:manage')
) AS p(name)
WHERE r."is_system" AND r."name" = 'Admin'
ON CONFLICT ("role_id", "name") DO NOTHING;

-- ============================================================================================================
-- Only an entry moves the counter and the head of the chain, for the application roles too: they hold UPDATE on the other
-- columns of the settings and on none of these two (advance_finance_head runs as the owner of the function). A column added
-- to finance_settings later has to be granted to them in its own migration: the default is closed.
-- ============================================================================================================
-- The settings row is never deleted: a new one would start the counter, the head and the lock of the books again
REVOKE UPDATE, DELETE ON TABLE finance_settings FROM platform_app, platform_worker;
GRANT UPDATE (country_code, base_currency, accounting_start_date, locked_through, recognize_sale_on, rounding_account_id, updated_at)
  ON TABLE finance_settings TO platform_app, platform_worker;

-- ============================================================================================================
-- A period keeps its place in the calendar, and a closed one is frozen (the time it closed, who closed it and the head of the
-- chain it froze) until the reopen action, which says who, when and why (TDD_18 §5)
-- ============================================================================================================
CREATE FUNCTION guard_fiscal_period_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'closed' THEN
      RAISE EXCEPTION 'FINANCE_PERIOD_CLOSED: a closed period is not deleted';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.organization_id <> OLD.organization_id OR NEW.year <> OLD.year OR NEW.month <> OLD.month
     OR NEW.starts_on <> OLD.starts_on OR NEW.ends_on <> OLD.ends_on THEN
    RAISE EXCEPTION 'FINANCE_PERIOD_CALENDAR: a period keeps its place in the calendar';
  END IF;
  -- An open period keeps the record of its earlier close and reopen as it is, and closing it does not touch the reopen record
  IF OLD.status = 'open' AND (NEW.reopened_at IS DISTINCT FROM OLD.reopened_at OR NEW.reopened_by IS DISTINCT FROM OLD.reopened_by
     OR NEW.reopen_reason IS DISTINCT FROM OLD.reopen_reason
     OR (NEW.status = 'open' AND (NEW.closing_hash IS DISTINCT FROM OLD.closing_hash OR NEW.closed_at IS DISTINCT FROM OLD.closed_at
                                  OR NEW.closed_by IS DISTINCT FROM OLD.closed_by))) THEN
    RAISE EXCEPTION 'FINANCE_PERIOD_CLOSED: the record of the close and of the reopen is kept';
  END IF;
  IF OLD.status = 'closed' THEN
    IF NEW.status = 'closed' THEN
      IF NEW.closing_hash IS DISTINCT FROM OLD.closing_hash OR NEW.closed_at IS DISTINCT FROM OLD.closed_at
         OR NEW.closed_by IS DISTINCT FROM OLD.closed_by OR NEW.reopened_at IS DISTINCT FROM OLD.reopened_at
         OR NEW.reopened_by IS DISTINCT FROM OLD.reopened_by OR NEW.reopen_reason IS DISTINCT FROM OLD.reopen_reason THEN
        RAISE EXCEPTION 'FINANCE_PERIOD_CLOSED: a closed period is frozen';
      END IF;
    -- A reopen is a new one: the time moves (the record of an earlier reopen does not do)
    ELSIF NEW.reopened_at IS NULL OR NEW.reopened_at IS NOT DISTINCT FROM OLD.reopened_at OR NEW.reopened_by IS NULL
          OR NEW.reopen_reason IS NULL OR btrim(NEW.reopen_reason) = '' THEN
      RAISE EXCEPTION 'FINANCE_REOPEN_RECORD: reopening a period says who, when and why';
    ELSIF NEW.closing_hash IS DISTINCT FROM OLD.closing_hash OR NEW.closed_at IS DISTINCT FROM OLD.closed_at
          OR NEW.closed_by IS DISTINCT FROM OLD.closed_by THEN
      -- The record of the close stays as it was, so the audit trail keeps what was closed and by whom
      RAISE EXCEPTION 'FINANCE_PERIOD_CLOSED: the record of the close is kept when a period is reopened';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_fiscal_periods_guard BEFORE UPDATE OR DELETE ON fiscal_periods
  FOR EACH ROW EXECUTE FUNCTION guard_fiscal_period_change();

-- ============================================================================================================
-- The sets of values that are hashed and frozen with an entry: a mistyped one cannot be corrected afterwards, so the database
-- holds the same list as finance-constants.ts (finance-schema.spec.ts compares them)
-- ============================================================================================================
ALTER TABLE journal_entries
  ADD CONSTRAINT chk_journal_entries_type CHECK (type IN (
    'manual', 'opening_balance', 'expense', 'income', 'transfer', 'sale', 'sale_shipment', 'sale_return', 'cod_remittance',
    'cod_write_off', 'purchase_receipt', 'supplier_payment', 'inventory_adjustment', 'reversal'
  )),
  ADD CONSTRAINT chk_journal_entries_source_type CHECK (source_type IS NULL OR source_type IN (
    'order', 'shipment', 'remittance', 'return', 'inventory_movement', 'purchase_receipt', 'supplier_payment',
    'finance_transaction', 'manual'
  )),
  ADD CONSTRAINT chk_journal_entries_memo CHECK (memo IS NULL OR char_length(memo) <= 500);
ALTER TABLE journal_lines
  ADD CONSTRAINT chk_journal_lines_memo CHECK (memo IS NULL OR char_length(memo) <= 500);
ALTER TABLE account_role_mappings
  ADD CONSTRAINT chk_account_role_mappings_role CHECK (role IN (
    'cash_default', 'bank_default', 'inventory', 'inventory_in_transit', 'receivable_carriers', 'customer_advances',
    'payable_suppliers', 'payable_carriers', 'vat_output', 'vat_input', 'sales_revenue', 'shipping_revenue', 'sales_discounts',
    'sales_returns', 'cost_of_goods_sold', 'inventory_loss', 'inventory_gain', 'carrier_freight_expense',
    'carrier_commission_expense', 'cod_differences', 'opening_equity', 'rounding', 'uncategorized_expense'
  ));

ALTER TABLE fiscal_periods
  ADD CONSTRAINT chk_fiscal_periods_reopen_reason CHECK (reopen_reason IS NULL OR char_length(reopen_reason) <= 500);
ALTER TABLE finance_posting_failures
  ADD CONSTRAINT chk_finance_posting_failures_source_type CHECK (source_type IN (
    'order', 'shipment', 'remittance', 'return', 'inventory_movement', 'purchase_receipt', 'supplier_payment',
    'finance_transaction', 'manual'
  )),
  ADD CONSTRAINT chk_finance_posting_failures_event_kind CHECK (char_length(event_kind) BETWEEN 1 AND 100);

-- ============================================================================================================
-- The balances by period follow the journal by trigger, in the transaction of each line, and the application roles can only
-- read them: they cannot drift from the immutable lines (the daily reconciliation compares them and raises, it never writes)
-- ============================================================================================================
CREATE FUNCTION apply_journal_line_to_balance() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_period text;
BEGIN
  SELECT e.period_id INTO v_period FROM journal_entries e WHERE e.id = NEW.entry_id;
  IF NEW.store_id IS NULL THEN
    INSERT INTO account_period_balances (id, organization_id, account_id, store_id, period_id, debit_cents, credit_cents, updated_at)
    VALUES (gen_random_uuid()::text, NEW.organization_id, NEW.account_id, NULL, v_period, NEW.debit_cents, NEW.credit_cents, now())
    ON CONFLICT (organization_id, account_id, period_id) WHERE store_id IS NULL
    DO UPDATE SET debit_cents = account_period_balances.debit_cents + EXCLUDED.debit_cents,
                  credit_cents = account_period_balances.credit_cents + EXCLUDED.credit_cents, updated_at = now();
  ELSE
    INSERT INTO account_period_balances (id, organization_id, account_id, store_id, period_id, debit_cents, credit_cents, updated_at)
    VALUES (gen_random_uuid()::text, NEW.organization_id, NEW.account_id, NEW.store_id, v_period, NEW.debit_cents, NEW.credit_cents, now())
    ON CONFLICT (organization_id, account_id, period_id, store_id) WHERE store_id IS NOT NULL
    DO UPDATE SET debit_cents = account_period_balances.debit_cents + EXCLUDED.debit_cents,
                  credit_cents = account_period_balances.credit_cents + EXCLUDED.credit_cents, updated_at = now();
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER trg_journal_lines_balance AFTER INSERT ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION apply_journal_line_to_balance();
REVOKE INSERT, UPDATE, DELETE ON TABLE account_period_balances FROM platform_app, platform_worker;
