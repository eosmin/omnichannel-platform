-- Rolls back 20270105100000_finance_book_layouts. DESTRUCTIVE: it drops every version of every layout of every legal book and every frozen
-- book. The books of a closed month could then not be handed over again as they were: export both tables first anywhere a book was relied
-- on. Safe to run twice.
BEGIN;
DROP TRIGGER IF EXISTS trg_finance_book_snapshots_no_truncate ON finance_book_snapshots;
DROP TRIGGER IF EXISTS trg_finance_book_snapshots_guard ON finance_book_snapshots;
DROP FUNCTION IF EXISTS finance_book_snapshot_guard();
DROP TABLE IF EXISTS finance_book_snapshots;
DROP TRIGGER IF EXISTS trg_finance_book_layouts_no_truncate ON finance_book_layouts;
DROP TRIGGER IF EXISTS trg_finance_book_layouts_guard ON finance_book_layouts;
DROP FUNCTION IF EXISTS finance_book_layout_guard();
DROP TABLE IF EXISTS finance_book_layouts;
COMMIT;
