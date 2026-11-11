-- Rolls back 20261125100000_stock_transfers. DESTRUCTIVE: every transfer and its lines are DROPPED with their rows (the
-- history of what was sent, received, written off or returned is lost; the movements already written in the ledger stay,
-- and they keep naming the transfer in their reference), and the permissions inventory:manage_transfers and
-- inventory:receive_transfers are taken from the roles. Take a copy of both tables first if their rows matter. A
-- transfer in transit holds units that left the source and have not arrived: the stock is NOT put back by this script.
-- Run it before the code that reads them is brought back. Safe to run twice.
BEGIN;

DELETE FROM "permissions" WHERE "name" IN ('inventory:manage_transfers', 'inventory:receive_transfers');

DROP TRIGGER IF EXISTS trg_stock_transfer_lines_belong_together ON stock_transfer_lines;
DROP FUNCTION IF EXISTS check_transfer_line_belongs_together();

DROP TABLE IF EXISTS "stock_transfer_lines";
DROP TABLE IF EXISTS "stock_transfers";

COMMIT;
