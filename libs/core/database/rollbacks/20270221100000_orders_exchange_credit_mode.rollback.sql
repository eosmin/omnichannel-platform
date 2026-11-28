-- Rolls back 20270221100000_orders_exchange_credit_mode: drops the mode of the credit of a replacement order.
-- WHAT IS LOST: which replacements were booked at the full price. After it every order reads as 'net' again, so a replacement already posted
-- 'gross' (its sale entry and its fiscal document at the full price) would be read net by the books, the VAT report and the sweep, and disagree
-- with what was posted. Roll back only before any replacement was made in 'gross', or reverse those entries by hand first. Safe to run twice.
-- ORDER: roll the code back with this script or after it (the code reads the column).
BEGIN;

ALTER TABLE IF EXISTS "orders" DROP CONSTRAINT IF EXISTS "orders_exchange_credit_mode_check";
ALTER TABLE IF EXISTS "orders" DROP COLUMN IF EXISTS "exchange_credit_mode";

COMMIT;
