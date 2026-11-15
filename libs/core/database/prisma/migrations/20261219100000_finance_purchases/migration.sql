-- AlterTable
ALTER TABLE "finance_settings" ADD COLUMN     "next_purchase_number" BIGINT NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "suppliers" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tax_id" TEXT,
    "contact_name" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "payment_terms_days" INTEGER NOT NULL DEFAULT 0,
    "default_payable_account_id" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_orders" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "supplier_id" TEXT NOT NULL,
    "warehouse_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "ordered_on" DATE,
    "expected_on" DATE,
    "notes" TEXT,
    "client_key" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_order_lines" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "purchase_order_id" TEXT NOT NULL,
    "line_no" INTEGER NOT NULL,
    "product_id" TEXT NOT NULL,
    "variant_id" TEXT,
    "quantity" INTEGER NOT NULL,
    "received_quantity" INTEGER NOT NULL DEFAULT 0,
    "unit_cost_cents" INTEGER NOT NULL,
    "tax_rate_id" TEXT,

    CONSTRAINT "purchase_order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_receipts" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "purchase_order_id" TEXT NOT NULL,
    "supplier_id" TEXT NOT NULL,
    "received_on" DATE NOT NULL,
    "due_on" DATE NOT NULL,
    "supplier_document_number" TEXT,
    "tax_creditable" BOOLEAN NOT NULL,
    "subtotal_cents" INTEGER NOT NULL,
    "tax_cents" INTEGER NOT NULL,
    "total_cents" INTEGER NOT NULL,
    "client_key" TEXT NOT NULL,
    "entry_id" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_receipt_lines" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "receipt_id" TEXT NOT NULL,
    "order_line_id" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_cost_cents" INTEGER NOT NULL,
    "subtotal_cents" INTEGER NOT NULL,
    "tax_cents" INTEGER NOT NULL,
    "movement_id" TEXT NOT NULL,

    CONSTRAINT "purchase_receipt_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_payments" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "supplier_id" TEXT NOT NULL,
    "purchase_receipt_id" TEXT,
    "paid_from_account_id" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "paid_on" DATE NOT NULL,
    "reference" TEXT,
    "client_key" TEXT NOT NULL,
    "entry_id" TEXT NOT NULL,
    "voided_by_entry_id" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "suppliers_organization_id_active_idx" ON "suppliers"("organization_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_organization_id_id_key" ON "suppliers"("organization_id", "id");

-- CreateIndex
CREATE INDEX "purchase_orders_organization_id_status_idx" ON "purchase_orders"("organization_id", "status");

-- CreateIndex
CREATE INDEX "purchase_orders_organization_id_supplier_id_idx" ON "purchase_orders"("organization_id", "supplier_id");

-- CreateIndex
CREATE INDEX "purchase_orders_organization_id_created_at_id_idx" ON "purchase_orders"("organization_id", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_orders_organization_id_id_key" ON "purchase_orders"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_orders_organization_id_number_key" ON "purchase_orders"("organization_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_orders_organization_id_client_key_key" ON "purchase_orders"("organization_id", "client_key");

-- CreateIndex
CREATE INDEX "purchase_order_lines_store_id_idx" ON "purchase_order_lines"("store_id");

-- CreateIndex
CREATE INDEX "purchase_order_lines_product_id_variant_id_idx" ON "purchase_order_lines"("product_id", "variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_order_lines_organization_id_id_key" ON "purchase_order_lines"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_order_lines_purchase_order_id_line_no_key" ON "purchase_order_lines"("purchase_order_id", "line_no");

-- CreateIndex
CREATE INDEX "purchase_receipts_organization_id_supplier_id_due_on_idx" ON "purchase_receipts"("organization_id", "supplier_id", "due_on");

-- CreateIndex
CREATE INDEX "purchase_receipts_purchase_order_id_idx" ON "purchase_receipts"("purchase_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_receipts_organization_id_id_key" ON "purchase_receipts"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_receipts_organization_id_client_key_key" ON "purchase_receipts"("organization_id", "client_key");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_receipts_organization_id_entry_id_key" ON "purchase_receipts"("organization_id", "entry_id");

-- CreateIndex
CREATE INDEX "purchase_receipt_lines_receipt_id_idx" ON "purchase_receipt_lines"("receipt_id");

-- CreateIndex
CREATE INDEX "purchase_receipt_lines_store_id_idx" ON "purchase_receipt_lines"("store_id");

-- CreateIndex
CREATE INDEX "purchase_receipt_lines_order_line_id_idx" ON "purchase_receipt_lines"("order_line_id");

-- CreateIndex
CREATE INDEX "supplier_payments_organization_id_supplier_id_paid_on_idx" ON "supplier_payments"("organization_id", "supplier_id", "paid_on");

-- CreateIndex
CREATE INDEX "supplier_payments_purchase_receipt_id_idx" ON "supplier_payments"("purchase_receipt_id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_payments_organization_id_id_key" ON "supplier_payments"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_payments_organization_id_client_key_key" ON "supplier_payments"("organization_id", "client_key");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_payments_organization_id_entry_id_key" ON "supplier_payments"("organization_id", "entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_payments_organization_id_voided_by_entry_id_key" ON "supplier_payments"("organization_id", "voided_by_entry_id");

-- AddForeignKey
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_organization_id_default_payable_account_id_fkey" FOREIGN KEY ("organization_id", "default_payable_account_id") REFERENCES "ledger_accounts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_organization_id_supplier_id_fkey" FOREIGN KEY ("organization_id", "supplier_id") REFERENCES "suppliers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_organization_id_warehouse_id_fkey" FOREIGN KEY ("organization_id", "warehouse_id") REFERENCES "warehouses"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_organization_id_purchase_order_id_fkey" FOREIGN KEY ("organization_id", "purchase_order_id") REFERENCES "purchase_orders"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_organization_id_store_id_fkey" FOREIGN KEY ("organization_id", "store_id") REFERENCES "stores"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_store_id_product_id_fkey" FOREIGN KEY ("store_id", "product_id") REFERENCES "products"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_organization_id_tax_rate_id_fkey" FOREIGN KEY ("organization_id", "tax_rate_id") REFERENCES "tax_rates"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_organization_id_purchase_order_id_fkey" FOREIGN KEY ("organization_id", "purchase_order_id") REFERENCES "purchase_orders"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_organization_id_supplier_id_fkey" FOREIGN KEY ("organization_id", "supplier_id") REFERENCES "suppliers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_organization_id_entry_id_fkey" FOREIGN KEY ("organization_id", "entry_id") REFERENCES "journal_entries"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_receipt_lines" ADD CONSTRAINT "purchase_receipt_lines_organization_id_receipt_id_fkey" FOREIGN KEY ("organization_id", "receipt_id") REFERENCES "purchase_receipts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_receipt_lines" ADD CONSTRAINT "purchase_receipt_lines_organization_id_store_id_fkey" FOREIGN KEY ("organization_id", "store_id") REFERENCES "stores"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_receipt_lines" ADD CONSTRAINT "purchase_receipt_lines_organization_id_order_line_id_fkey" FOREIGN KEY ("organization_id", "order_line_id") REFERENCES "purchase_order_lines"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_organization_id_supplier_id_fkey" FOREIGN KEY ("organization_id", "supplier_id") REFERENCES "suppliers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_organization_id_purchase_receipt_id_fkey" FOREIGN KEY ("organization_id", "purchase_receipt_id") REFERENCES "purchase_receipts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_organization_id_paid_from_account_id_fkey" FOREIGN KEY ("organization_id", "paid_from_account_id") REFERENCES "ledger_accounts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_organization_id_entry_id_fkey" FOREIGN KEY ("organization_id", "entry_id") REFERENCES "journal_entries"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_organization_id_voided_by_entry_id_fkey" FOREIGN KEY ("organization_id", "voided_by_entry_id") REFERENCES "journal_entries"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================================================
-- Step 4B.5 (TDD_18 §2.7, §4.2 E10 and E11): suppliers, purchase orders, receipts and supplier payments. The rules below are the net under
-- the services that write these tables (the only writers, through the posting service and the stock engine): the shape of every row, the
-- entry a receipt or a payment belongs to, and the immutability of what was posted, whoever writes. Whole USD cents.
-- ============================================================================================================
ALTER TABLE finance_settings
  ADD CONSTRAINT chk_finance_settings_next_purchase_number CHECK (next_purchase_number >= 1);

-- The name is unique per organization ignoring case (the service answers it typed; this is the last word when two requests race)
CREATE UNIQUE INDEX uq_suppliers_org_lower_name ON suppliers (organization_id, lower(name));

ALTER TABLE suppliers
  ADD CONSTRAINT chk_suppliers_name CHECK (char_length(name) BETWEEN 1 AND 150),
  ADD CONSTRAINT chk_suppliers_terms CHECK (payment_terms_days BETWEEN 0 AND 365);

ALTER TABLE purchase_orders
  ADD CONSTRAINT chk_purchase_orders_status CHECK (status IN ('draft', 'ordered', 'partially_received', 'received', 'closed', 'cancelled')),
  ADD CONSTRAINT chk_purchase_orders_number CHECK (char_length(number) BETWEEN 1 AND 40),
  ADD CONSTRAINT chk_purchase_orders_client_key CHECK (char_length(client_key) BETWEEN 1 AND 200),
  -- A placed order has the day it was placed; a draft has none
  ADD CONSTRAINT chk_purchase_orders_ordered_on CHECK ((status = 'draft') = (ordered_on IS NULL) OR status = 'cancelled');

ALTER TABLE purchase_order_lines
  ADD CONSTRAINT chk_purchase_order_lines_quantity CHECK (quantity BETWEEN 1 AND 1000000),
  ADD CONSTRAINT chk_purchase_order_lines_received CHECK (received_quantity BETWEEN 0 AND quantity),
  ADD CONSTRAINT chk_purchase_order_lines_cost CHECK (unit_cost_cents >= 0),
  ADD CONSTRAINT chk_purchase_order_lines_line_no CHECK (line_no >= 1);

ALTER TABLE purchase_receipts
  ADD CONSTRAINT chk_purchase_receipts_money CHECK (subtotal_cents >= 0 AND tax_cents >= 0 AND total_cents > 0 AND total_cents = subtotal_cents + tax_cents),
  ADD CONSTRAINT chk_purchase_receipts_due CHECK (due_on >= received_on),
  ADD CONSTRAINT chk_purchase_receipts_creditable CHECK (NOT tax_creditable OR supplier_document_number IS NOT NULL),
  ADD CONSTRAINT chk_purchase_receipts_document CHECK (supplier_document_number IS NULL OR char_length(supplier_document_number) BETWEEN 1 AND 100),
  ADD CONSTRAINT chk_purchase_receipts_client_key CHECK (char_length(client_key) BETWEEN 1 AND 200);

ALTER TABLE purchase_receipt_lines
  ADD CONSTRAINT chk_purchase_receipt_lines_quantity CHECK (quantity BETWEEN 1 AND 1000000),
  ADD CONSTRAINT chk_purchase_receipt_lines_money CHECK (unit_cost_cents >= 0 AND subtotal_cents = quantity::bigint * unit_cost_cents AND tax_cents >= 0);

ALTER TABLE supplier_payments
  ADD CONSTRAINT chk_supplier_payments_amount CHECK (amount_cents > 0),
  ADD CONSTRAINT chk_supplier_payments_reference CHECK (reference IS NULL OR char_length(reference) BETWEEN 1 AND 100),
  ADD CONSTRAINT chk_supplier_payments_client_key CHECK (char_length(client_key) BETWEEN 1 AND 200),
  ADD CONSTRAINT chk_supplier_payments_void CHECK (voided_by_entry_id IS NULL OR voided_by_entry_id <> entry_id);

-- A receipt: the order is the supplier's, and the entry is the one of this receipt, for its total, on its day, written by a person (the
-- service checks the same rules first; a trigger that fires is a race or a bug and surfaces as the error it is)
CREATE FUNCTION check_purchase_receipt_row() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
DECLARE
  purchase purchase_orders%ROWTYPE;
  posted journal_entries%ROWTYPE;
BEGIN
  SELECT * INTO purchase FROM purchase_orders WHERE id = NEW.purchase_order_id AND organization_id = NEW.organization_id;
  IF purchase.id IS NULL OR purchase.supplier_id <> NEW.supplier_id THEN
    RAISE EXCEPTION 'PURCHASE_RECEIPT_ORDER: the receipt is not of the supplier of its order';
  END IF;
  SELECT * INTO posted FROM journal_entries WHERE id = NEW.entry_id AND organization_id = NEW.organization_id;
  IF posted.type IS DISTINCT FROM 'purchase_receipt'
     OR posted.source_type IS DISTINCT FROM 'purchase_receipt'
     OR posted.source_id IS DISTINCT FROM NEW.id
     OR posted.total_cents IS DISTINCT FROM NEW.total_cents
     OR posted.entry_date IS DISTINCT FROM NEW.received_on
     OR posted.reverses_entry_id IS NOT NULL THEN
    RAISE EXCEPTION 'PURCHASE_RECEIPT_ENTRY: the entry is not the one this receipt posts';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_purchase_receipts_check
BEFORE INSERT ON purchase_receipts
FOR EACH ROW EXECUTE FUNCTION check_purchase_receipt_row();

-- A payment: from a cash, bank or wallet account, the bill (when it names one) is the supplier's, and the entry is the one of this payment,
-- for its amount, on its day. After that the only change is the pointer to the entry that voids it, once, to the reversal of its own entry.
CREATE FUNCTION check_supplier_payment_row() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
DECLARE
  source_account ledger_accounts%ROWTYPE;
  bill purchase_receipts%ROWTYPE;
  posted journal_entries%ROWTYPE;
  voiding journal_entries%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.voided_by_entry_id IS NOT NULL THEN
      RAISE EXCEPTION 'SUPPLIER_PAYMENT_IMMUTABLE: a payment is born live and voided by an update';
    END IF;
    SELECT * INTO source_account FROM ledger_accounts WHERE id = NEW.paid_from_account_id AND organization_id = NEW.organization_id;
    IF source_account.cash_kind IS NULL THEN
      RAISE EXCEPTION 'SUPPLIER_PAYMENT_ACCOUNT: the money does not leave a cash, bank or wallet account';
    END IF;
    IF NEW.purchase_receipt_id IS NOT NULL THEN
      SELECT * INTO bill FROM purchase_receipts WHERE id = NEW.purchase_receipt_id AND organization_id = NEW.organization_id;
      IF bill.supplier_id IS DISTINCT FROM NEW.supplier_id THEN
        RAISE EXCEPTION 'SUPPLIER_PAYMENT_BILL: the bill is not the supplier''s';
      END IF;
    END IF;
    SELECT * INTO posted FROM journal_entries WHERE id = NEW.entry_id AND organization_id = NEW.organization_id;
    IF posted.type IS DISTINCT FROM 'supplier_payment'
       OR posted.source_type IS DISTINCT FROM 'supplier_payment'
       OR posted.source_id IS DISTINCT FROM NEW.id
       OR posted.total_cents IS DISTINCT FROM NEW.amount_cents
       OR posted.entry_date IS DISTINCT FROM NEW.paid_on
       OR posted.reverses_entry_id IS NOT NULL THEN
      RAISE EXCEPTION 'SUPPLIER_PAYMENT_ENTRY: the entry is not the one this payment posts';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.voided_by_entry_id IS NULL OR OLD.voided_by_entry_id IS NOT NULL THEN
    RAISE EXCEPTION 'SUPPLIER_PAYMENT_IMMUTABLE: a payment is voided once and never changed';
  END IF;
  IF (to_jsonb(NEW) - 'voided_by_entry_id') IS DISTINCT FROM (to_jsonb(OLD) - 'voided_by_entry_id') THEN
    RAISE EXCEPTION 'SUPPLIER_PAYMENT_IMMUTABLE: a payment is voided once and never changed';
  END IF;
  SELECT * INTO voiding FROM journal_entries WHERE id = NEW.voided_by_entry_id AND organization_id = NEW.organization_id;
  IF voiding.reverses_entry_id IS DISTINCT FROM NEW.entry_id THEN
    RAISE EXCEPTION 'SUPPLIER_PAYMENT_ENTRY: the entry that voids it does not reverse its entry';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_supplier_payments_check
BEFORE INSERT OR UPDATE ON supplier_payments
FOR EACH ROW EXECUTE FUNCTION check_supplier_payment_row();

-- A receipt, its lines and a payment are never deleted, and a receipt and its lines are never changed
CREATE FUNCTION forbid_purchase_removal() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'PURCHASE_IMMUTABLE: a receipt or a payment is voided or returned, never deleted or changed';
END $$;

CREATE TRIGGER trg_purchase_receipts_immutable
BEFORE UPDATE OR DELETE ON purchase_receipts
FOR EACH ROW EXECUTE FUNCTION forbid_purchase_removal();
CREATE TRIGGER trg_purchase_receipts_no_truncate
BEFORE TRUNCATE ON purchase_receipts
FOR EACH STATEMENT EXECUTE FUNCTION forbid_purchase_removal();

CREATE TRIGGER trg_purchase_receipt_lines_immutable
BEFORE UPDATE OR DELETE ON purchase_receipt_lines
FOR EACH ROW EXECUTE FUNCTION forbid_purchase_removal();
CREATE TRIGGER trg_purchase_receipt_lines_no_truncate
BEFORE TRUNCATE ON purchase_receipt_lines
FOR EACH STATEMENT EXECUTE FUNCTION forbid_purchase_removal();

CREATE TRIGGER trg_supplier_payments_no_delete
BEFORE DELETE ON supplier_payments
FOR EACH ROW EXECUTE FUNCTION forbid_purchase_removal();
CREATE TRIGGER trg_supplier_payments_no_truncate
BEFORE TRUNCATE ON supplier_payments
FOR EACH STATEMENT EXECUTE FUNCTION forbid_purchase_removal();

-- The application roles may add them, and a payment may be pointed at the entry that voids it: no other column is theirs to change
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE purchase_receipts, purchase_receipt_lines FROM platform_app, platform_worker;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE supplier_payments FROM platform_app, platform_worker;
GRANT UPDATE (voided_by_entry_id) ON TABLE supplier_payments TO platform_app, platform_worker;

-- A column added to finance_settings has to be granted to the application roles by its own migration: the default is closed
-- (20261213110000_finance_ledger). The counter of the purchase numbers moves with every order the application creates.
GRANT UPDATE ("next_purchase_number") ON TABLE finance_settings TO platform_app, platform_worker;
