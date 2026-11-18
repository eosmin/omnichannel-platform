-- HC-121 (TDD_18 §4.2 E11b): what a supplier gave back of a payment. A payment that the bank returned or that bounced is not a voided payment
-- (it happened and the bank saw it): it is a return with its own entry, which the bank statement can match, and the debt is owed again.

-- CreateTable
CREATE TABLE "supplier_payment_returns" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "supplier_id" TEXT NOT NULL,
    "supplier_payment_id" TEXT NOT NULL,
    "received_into_account_id" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "returned_on" DATE NOT NULL,
    "reference" TEXT,
    "client_key" TEXT NOT NULL,
    "entry_id" TEXT NOT NULL,
    "voided_by_entry_id" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_payment_returns_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "supplier_payment_returns_organization_id_supplier_id_return_idx" ON "supplier_payment_returns"("organization_id", "supplier_id", "returned_on");

-- CreateIndex
CREATE INDEX "supplier_payment_returns_organization_id_supplier_payment_i_idx" ON "supplier_payment_returns"("organization_id", "supplier_payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_payment_returns_organization_id_id_key" ON "supplier_payment_returns"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_payment_returns_organization_id_client_key_key" ON "supplier_payment_returns"("organization_id", "client_key");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_payment_returns_organization_id_entry_id_key" ON "supplier_payment_returns"("organization_id", "entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_payment_returns_organization_id_voided_by_entry_id_key" ON "supplier_payment_returns"("organization_id", "voided_by_entry_id");

-- AddForeignKey
ALTER TABLE "supplier_payment_returns" ADD CONSTRAINT "supplier_payment_returns_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payment_returns" ADD CONSTRAINT "supplier_payment_returns_organization_id_supplier_id_fkey" FOREIGN KEY ("organization_id", "supplier_id") REFERENCES "suppliers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payment_returns" ADD CONSTRAINT "supplier_payment_returns_organization_id_supplier_payment__fkey" FOREIGN KEY ("organization_id", "supplier_payment_id") REFERENCES "supplier_payments"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payment_returns" ADD CONSTRAINT "supplier_payment_returns_organization_id_received_into_acc_fkey" FOREIGN KEY ("organization_id", "received_into_account_id") REFERENCES "ledger_accounts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payment_returns" ADD CONSTRAINT "supplier_payment_returns_organization_id_entry_id_fkey" FOREIGN KEY ("organization_id", "entry_id") REFERENCES "journal_entries"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payment_returns" ADD CONSTRAINT "supplier_payment_returns_organization_id_voided_by_entry_i_fkey" FOREIGN KEY ("organization_id", "voided_by_entry_id") REFERENCES "journal_entries"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================================================
-- The sets of values frozen with an entry gain the type and the source of the return (finance-schema.spec compares them with the enums)
-- ============================================================================================================
ALTER TABLE journal_entries
  DROP CONSTRAINT chk_journal_entries_type,
  DROP CONSTRAINT chk_journal_entries_source_type;
ALTER TABLE journal_entries
  ADD CONSTRAINT chk_journal_entries_type CHECK (type IN (
    'manual', 'opening_balance', 'expense', 'income', 'transfer', 'sale', 'sale_shipment', 'sale_return', 'cod_remittance',
    'cod_write_off', 'purchase_receipt', 'supplier_payment', 'supplier_payment_return', 'inventory_adjustment', 'reversal'
  )),
  ADD CONSTRAINT chk_journal_entries_source_type CHECK (source_type IS NULL OR source_type IN (
    'order', 'shipment', 'remittance', 'return', 'inventory_movement', 'purchase_receipt', 'supplier_payment', 'supplier_payment_return',
    'finance_transaction', 'manual'
  ));
ALTER TABLE finance_posting_failures
  DROP CONSTRAINT chk_finance_posting_failures_source_type;
ALTER TABLE finance_posting_failures
  ADD CONSTRAINT chk_finance_posting_failures_source_type CHECK (source_type IN (
    'order', 'shipment', 'remittance', 'return', 'inventory_movement', 'purchase_receipt', 'supplier_payment', 'supplier_payment_return',
    'finance_transaction', 'manual'
  ));

-- ============================================================================================================
-- The shape of every row and the net under the service (the only writer): the amount, the day, the key, the account the money came back
-- into (cash, bank or wallet), the payment (of the same supplier, live, and never returned for more than it was) and the entry that
-- belongs to this return. After that the only change is the pointer to the entry that voids it, once.
-- ============================================================================================================
ALTER TABLE supplier_payment_returns
  ADD CONSTRAINT chk_supplier_payment_returns_amount CHECK (amount_cents > 0),
  ADD CONSTRAINT chk_supplier_payment_returns_reference CHECK (reference IS NULL OR char_length(reference) BETWEEN 1 AND 100),
  ADD CONSTRAINT chk_supplier_payment_returns_client_key CHECK (char_length(client_key) BETWEEN 1 AND 200),
  ADD CONSTRAINT chk_supplier_payment_returns_void CHECK (voided_by_entry_id IS NULL OR voided_by_entry_id <> entry_id);

CREATE FUNCTION check_supplier_payment_return_row() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
DECLARE
  into_account ledger_accounts%ROWTYPE;
  paid supplier_payments%ROWTYPE;
  posted journal_entries%ROWTYPE;
  voiding journal_entries%ROWTYPE;
  already bigint;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.voided_by_entry_id IS NOT NULL THEN
      RAISE EXCEPTION 'SUPPLIER_PAYMENT_RETURN_IMMUTABLE: a return is born live and voided by an update';
    END IF;
    SELECT * INTO into_account FROM ledger_accounts WHERE id = NEW.received_into_account_id AND organization_id = NEW.organization_id;
    IF into_account.cash_kind IS NULL THEN
      RAISE EXCEPTION 'SUPPLIER_PAYMENT_RETURN_ACCOUNT: the money does not come back into a cash, bank or wallet account';
    END IF;
    -- The payment is locked while it is checked, like a payment that is being voided (the same lock below): a return and the voiding
    -- of its payment take turns, and two returns never pass the payment together
    PERFORM pg_advisory_xact_lock(hashtextextended('supplier_payment:' || NEW.supplier_payment_id, 0));
    SELECT * INTO paid FROM supplier_payments WHERE id = NEW.supplier_payment_id AND organization_id = NEW.organization_id;
    IF paid.id IS NULL OR paid.supplier_id <> NEW.supplier_id THEN
      RAISE EXCEPTION 'SUPPLIER_PAYMENT_RETURN_PAYMENT: the payment is not the supplier''s';
    END IF;
    IF paid.voided_by_entry_id IS NOT NULL THEN
      RAISE EXCEPTION 'SUPPLIER_PAYMENT_RETURN_PAYMENT: a voided payment has nothing to give back';
    END IF;
    IF NEW.returned_on < paid.paid_on THEN
      RAISE EXCEPTION 'SUPPLIER_PAYMENT_RETURN_PAYMENT: the money cannot come back before it went out';
    END IF;
    SELECT COALESCE(SUM(amount_cents), 0) INTO already
    FROM supplier_payment_returns
    WHERE supplier_payment_id = NEW.supplier_payment_id AND organization_id = NEW.organization_id AND voided_by_entry_id IS NULL;
    IF already + NEW.amount_cents > paid.amount_cents THEN
      RAISE EXCEPTION 'SUPPLIER_PAYMENT_RETURN_AMOUNT: a payment is never given back for more than it was';
    END IF;
    SELECT * INTO posted FROM journal_entries WHERE id = NEW.entry_id AND organization_id = NEW.organization_id;
    IF posted.type IS DISTINCT FROM 'supplier_payment_return'
       OR posted.source_type IS DISTINCT FROM 'supplier_payment_return'
       OR posted.source_id IS DISTINCT FROM NEW.id
       OR posted.total_cents IS DISTINCT FROM NEW.amount_cents
       OR posted.entry_date IS DISTINCT FROM NEW.returned_on
       OR posted.reverses_entry_id IS NOT NULL THEN
      RAISE EXCEPTION 'SUPPLIER_PAYMENT_RETURN_ENTRY: the entry is not the one this return posts';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.voided_by_entry_id IS NULL OR OLD.voided_by_entry_id IS NOT NULL THEN
    RAISE EXCEPTION 'SUPPLIER_PAYMENT_RETURN_IMMUTABLE: a return is voided once and never changed';
  END IF;
  IF (to_jsonb(NEW) - 'voided_by_entry_id') IS DISTINCT FROM (to_jsonb(OLD) - 'voided_by_entry_id') THEN
    RAISE EXCEPTION 'SUPPLIER_PAYMENT_RETURN_IMMUTABLE: a return is voided once and never changed';
  END IF;
  SELECT * INTO voiding FROM journal_entries WHERE id = NEW.voided_by_entry_id AND organization_id = NEW.organization_id;
  IF voiding.reverses_entry_id IS DISTINCT FROM NEW.entry_id THEN
    RAISE EXCEPTION 'SUPPLIER_PAYMENT_RETURN_ENTRY: the entry that voids it does not reverse its entry';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_supplier_payment_returns_check
BEFORE INSERT OR UPDATE ON supplier_payment_returns
FOR EACH ROW EXECUTE FUNCTION check_supplier_payment_return_row();

-- A payment with a live return is not voided: its debt would be reopened twice (the service says it first; this is the net, under the lock a
-- return takes)
CREATE FUNCTION forbid_void_of_returned_payment() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.voided_by_entry_id IS NOT NULL AND OLD.voided_by_entry_id IS NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('supplier_payment:' || NEW.id, 0));
    IF EXISTS (
      SELECT 1 FROM supplier_payment_returns
      WHERE supplier_payment_id = NEW.id AND organization_id = NEW.organization_id AND voided_by_entry_id IS NULL
    ) THEN
      RAISE EXCEPTION 'SUPPLIER_PAYMENT_HAS_RETURNS: the payment has a return: void the return first';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_supplier_payments_returned
BEFORE UPDATE ON supplier_payments
FOR EACH ROW EXECUTE FUNCTION forbid_void_of_returned_payment();

-- A return is never deleted
CREATE TRIGGER trg_supplier_payment_returns_no_delete
BEFORE DELETE ON supplier_payment_returns
FOR EACH ROW EXECUTE FUNCTION forbid_purchase_removal();
CREATE TRIGGER trg_supplier_payment_returns_no_truncate
BEFORE TRUNCATE ON supplier_payment_returns
FOR EACH STATEMENT EXECUTE FUNCTION forbid_purchase_removal();

-- The application roles may add them, and a return may be pointed at the entry that voids it: no other column is theirs to change
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE supplier_payment_returns FROM platform_app, platform_worker;
GRANT UPDATE (voided_by_entry_id) ON TABLE supplier_payment_returns TO platform_app, platform_worker;
