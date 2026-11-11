-- Rolls back 20261126100000_stock_counts: the physical counts and their lines are dropped. Counts already applied
-- keep their effect: the stock movements they wrote stay in the ledger (inventory_movements, reference_type 'count'),
-- which is append-only; only the header and the lines that explain them are lost.
BEGIN;

DROP TRIGGER IF EXISTS trg_stock_counts_scope ON stock_counts;
DROP TRIGGER IF EXISTS trg_stock_count_lines_count_is_open ON stock_count_lines;
DROP TRIGGER IF EXISTS trg_stock_count_lines_snapshot ON stock_count_lines;
DROP TRIGGER IF EXISTS trg_stock_count_lines_belong_together ON stock_count_lines;
DROP FUNCTION IF EXISTS keep_stock_count_scope();
DROP FUNCTION IF EXISTS check_stock_count_line_count_is_open();
DROP FUNCTION IF EXISTS keep_stock_count_line_snapshot();
DROP FUNCTION IF EXISTS check_stock_count_line_belongs_together();

DROP TABLE IF EXISTS "stock_count_lines";
DROP TABLE IF EXISTS "stock_counts";

COMMIT;
