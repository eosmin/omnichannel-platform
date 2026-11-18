-- Rolls back 20270120140000_bank_reconciliation_groups: the decisions go back to pairs only. A database that holds a confirmed GROUP cannot go
-- back past this migration without a decision about those groups (their rows would be several confirmed matches of one statement line,
-- each with an amount that is not the line's): the unique index of the pairs cannot be built again and the whole script stops with nothing
-- changed. Take the groups back (undo) first. Safe to run twice.
BEGIN;

DROP TRIGGER IF EXISTS trg_reconciliation_group ON reconciliation_matches;
DROP FUNCTION IF EXISTS check_reconciliation_group();

DROP INDEX IF EXISTS uq_reconciliation_confirmed_statement_line;
CREATE UNIQUE INDEX uq_reconciliation_confirmed_statement_line ON reconciliation_matches (statement_line_id) WHERE status = 'confirmed';

CREATE OR REPLACE FUNCTION check_reconciliation_match_row() RETURNS trigger
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
      PERFORM pg_advisory_xact_lock(hashtextextended('finance_entry:' || book.entry_id, 0));
      SELECT * INTO book_entry FROM journal_entries WHERE id = book.entry_id AND organization_id = NEW.organization_id;
      IF book_entry.reverses_entry_id IS NOT NULL
         OR EXISTS (SELECT 1 FROM journal_entries WHERE reverses_entry_id = book_entry.id AND organization_id = NEW.organization_id) THEN
        RAISE EXCEPTION 'RECONCILIATION_MATCH: a reversed entry and its reversal are never matched with the bank';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'undone'
     OR NEW.status <> 'undone'
     OR (to_jsonb(NEW) - 'status' - 'undone_by' - 'undone_at') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'undone_by' - 'undone_at') THEN
    RAISE EXCEPTION 'RECONCILIATION_MATCH: a decision is only taken back, once';
  END IF;
  RETURN NEW;
END $$;

ALTER TABLE reconciliation_matches DROP CONSTRAINT IF EXISTS chk_reconciliation_group_lead;
ALTER TABLE reconciliation_matches DROP CONSTRAINT IF EXISTS chk_reconciliation_group;
DROP INDEX IF EXISTS "reconciliation_matches_organization_id_group_id_idx";
ALTER TABLE "reconciliation_matches" DROP COLUMN IF EXISTS "is_group_lead";
ALTER TABLE "reconciliation_matches" DROP COLUMN IF EXISTS "group_id";

COMMIT;
