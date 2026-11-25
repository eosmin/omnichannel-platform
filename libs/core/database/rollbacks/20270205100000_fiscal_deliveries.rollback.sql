-- Rollback of 20270205100000_fiscal_deliveries: the table goes with its policies, indexes and keys. The record of what was delivered to
-- each receiver is lost (the files themselves, the messages and the emails already sent stay), and the documents accepted from then on are
-- not delivered by the platform. Safe to run twice.
BEGIN;
DROP TABLE IF EXISTS "fiscal_deliveries";
COMMIT;
