-- HC-121 (TDD_18 §4.4): ONE statement line against SEVERAL lines of the journal of the same account, decided by a person. The decisions of a
-- group share `group_id`; the signed sum of the lines of the books of a group is exactly the amount of the statement line, checked by a
-- constraint trigger that runs at the commit of the transaction and fails closed: a group that does not add up exactly is never kept,
-- whoever wrote it and in whatever order its rows were written.

-- AlterTable
ALTER TABLE "reconciliation_matches" ADD COLUMN "group_id" TEXT;
ALTER TABLE "reconciliation_matches" ADD COLUMN "is_group_lead" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "reconciliation_matches_organization_id_group_id_idx" ON "reconciliation_matches"("organization_id", "group_id");

-- A rejection is of a pair: only a confirmed decision (and the one taken back after) belongs to a group
ALTER TABLE reconciliation_matches
  ADD CONSTRAINT chk_reconciliation_group CHECK (group_id IS NULL OR status IN ('confirmed', 'undone')),
  ADD CONSTRAINT chk_reconciliation_group_lead CHECK (group_id IS NOT NULL OR NOT is_group_lead);

-- A statement line has at most one confirmed PAIR, or ONE group: the pair, and the lead (one row per group, chosen by the service), are the
-- rows the index holds, so two groups, or a pair and a group, of one statement line cannot both be confirmed whatever the isolation level of
-- the writers (the lock and the checks of the trigger below say it first with a typed error)
DROP INDEX uq_reconciliation_confirmed_statement_line;
CREATE UNIQUE INDEX uq_reconciliation_confirmed_statement_line ON reconciliation_matches (statement_line_id) WHERE status = 'confirmed' AND (group_id IS NULL OR is_group_lead);

-- The decision. A pair keeps its rule (the same amount in the same direction); a row of a group skips the amount of the row (the group
-- is checked as a whole below). Both take the lock of the statement line first, so a pair and a group, or two groups, of the same line
-- take turns and the second one sees the first.
CREATE OR REPLACE FUNCTION check_reconciliation_match_row() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  statement public.bank_statement_lines%ROWTYPE;
  book public.journal_lines%ROWTYPE;
  book_entry public.journal_entries%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'undone' THEN
      RAISE EXCEPTION 'RECONCILIATION_MATCH: a decision is born confirmed or rejected';
    END IF;
    SELECT * INTO statement FROM public.bank_statement_lines WHERE id = NEW.statement_line_id AND organization_id = NEW.organization_id;
    SELECT * INTO book FROM public.journal_lines WHERE id = NEW.journal_line_id AND organization_id = NEW.organization_id;
    IF statement.id IS NULL OR book.id IS NULL OR statement.account_id IS DISTINCT FROM book.account_id THEN
      RAISE EXCEPTION 'RECONCILIATION_MATCH: the lines are not of the same account of the organization';
    END IF;
    IF NEW.status = 'confirmed' THEN
      PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('bank_line:' || NEW.statement_line_id, 0));
      IF NEW.group_id IS NULL THEN
        IF EXISTS (
          SELECT 1 FROM public.reconciliation_matches
          WHERE statement_line_id = NEW.statement_line_id AND status = 'confirmed' AND group_id IS NOT NULL
        ) THEN
          RAISE EXCEPTION 'RECONCILIATION_MATCH: the statement line is matched by a group';
        END IF;
        IF statement.amount_cents IS DISTINCT FROM (book.debit_cents - book.credit_cents) THEN
          RAISE EXCEPTION 'RECONCILIATION_MATCH: the amounts are not the same movement';
        END IF;
      ELSE
        IF EXISTS (
          SELECT 1 FROM public.reconciliation_matches
          WHERE statement_line_id = NEW.statement_line_id AND status = 'confirmed' AND group_id IS DISTINCT FROM NEW.group_id
        ) THEN
          RAISE EXCEPTION 'RECONCILIATION_GROUP: the statement line is matched already';
        END IF;
      END IF;
      -- A confirmation and the reversal of the same entry take turns (the reversal takes the same lock below): whichever comes second sees
      -- the other, so a match on a reversed entry cannot be made by a race
      PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('finance_entry:' || book.entry_id, 0));
      SELECT * INTO book_entry FROM public.journal_entries WHERE id = book.entry_id AND organization_id = NEW.organization_id;
      IF book_entry.reverses_entry_id IS NOT NULL
         OR EXISTS (SELECT 1 FROM public.journal_entries WHERE reverses_entry_id = book_entry.id AND organization_id = NEW.organization_id) THEN
        RAISE EXCEPTION 'RECONCILIATION_MATCH: a reversed entry and its reversal are never matched with the bank';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE: a decision is taken back once and nothing else moves (the group of a row never changes)
  IF OLD.status = 'undone'
     OR NEW.status <> 'undone'
     OR (pg_catalog.to_jsonb(NEW) - 'status' - 'undone_by' - 'undone_at') IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - 'status' - 'undone_by' - 'undone_at') THEN
    RAISE EXCEPTION 'RECONCILIATION_MATCH: a decision is only taken back, once';
  END IF;
  RETURN NEW;
END $$;

-- The group as a whole, at the COMMIT of the transaction (the rows of a group are written one by one, so no row can say it alone): the
-- confirmed rows of the group are of ONE statement line, at least two, with exactly one lead, and the signed sum of their lines of the books is exactly the amount
-- of that line. It also runs when a row of a group is taken back, so a group is taken back whole or not at all. Fails closed.
CREATE FUNCTION check_reconciliation_group() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  pieces integer;
  leads integer;
  statement_lines integer;
  total bigint;
  statement_cents integer;
BEGIN
  SELECT pg_catalog.count(*), pg_catalog.count(*) FILTER (WHERE m.is_group_lead), pg_catalog.count(DISTINCT m.statement_line_id), COALESCE(pg_catalog.sum(l.debit_cents - l.credit_cents), 0)
  INTO pieces, leads, statement_lines, total
  FROM public.reconciliation_matches m
  JOIN public.journal_lines l ON l.id = m.journal_line_id AND l.organization_id = m.organization_id
  WHERE m.organization_id = NEW.organization_id AND m.group_id = NEW.group_id AND m.status = 'confirmed';
  -- A group taken back whole has nothing confirmed left
  IF pieces = 0 THEN
    RETURN NULL;
  END IF;
  SELECT s.amount_cents INTO statement_cents
  FROM public.bank_statement_lines s
  WHERE s.id = NEW.statement_line_id AND s.organization_id = NEW.organization_id;
  IF statement_lines <> 1 OR pieces < 2 OR leads <> 1 OR statement_cents IS NULL OR total IS DISTINCT FROM statement_cents::bigint THEN
    RAISE EXCEPTION 'RECONCILIATION_GROUP: the lines of the group do not add up to the statement line';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER trg_reconciliation_group
AFTER INSERT OR UPDATE ON reconciliation_matches
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (NEW.group_id IS NOT NULL)
EXECUTE FUNCTION check_reconciliation_group();
