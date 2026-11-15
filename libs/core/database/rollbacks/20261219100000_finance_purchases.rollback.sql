-- Rolls back 20261219100000_finance_purchases. DESTRUCTIVE: every supplier, purchase order, receipt and supplier payment is DROPPED with its
-- rows (the journal entries they posted stay: the journal is append-only and is not touched here, so after this the entries of receipts and
-- payments have no operational header; and the stock the receipts raised stays in the ledger of stock, which is append-only too: take a
-- copy of the tables first if the rows matter). Receipts and payments refuse deletes, so their triggers go first. Run it before the code
-- that reads these tables is brought back. Safe to run twice.
BEGIN;

DROP TRIGGER IF EXISTS trg_supplier_payments_no_truncate ON supplier_payments;
DROP TRIGGER IF EXISTS trg_supplier_payments_no_delete ON supplier_payments;
DROP TRIGGER IF EXISTS trg_supplier_payments_check ON supplier_payments;
DROP TRIGGER IF EXISTS trg_purchase_receipt_lines_no_truncate ON purchase_receipt_lines;
DROP TRIGGER IF EXISTS trg_purchase_receipt_lines_immutable ON purchase_receipt_lines;
DROP TRIGGER IF EXISTS trg_purchase_receipts_no_truncate ON purchase_receipts;
DROP TRIGGER IF EXISTS trg_purchase_receipts_immutable ON purchase_receipts;
DROP TRIGGER IF EXISTS trg_purchase_receipts_check ON purchase_receipts;
DROP FUNCTION IF EXISTS forbid_purchase_removal();
DROP FUNCTION IF EXISTS check_supplier_payment_row();
DROP FUNCTION IF EXISTS check_purchase_receipt_row();

DROP TABLE IF EXISTS "supplier_payments";
DROP TABLE IF EXISTS "purchase_receipt_lines";
DROP TABLE IF EXISTS "purchase_receipts";
DROP TABLE IF EXISTS "purchase_order_lines";
DROP TABLE IF EXISTS "purchase_orders";
DROP TABLE IF EXISTS "suppliers";

ALTER TABLE "finance_settings" DROP CONSTRAINT IF EXISTS chk_finance_settings_next_purchase_number;
ALTER TABLE "finance_settings" DROP COLUMN IF EXISTS "next_purchase_number";

COMMIT;
