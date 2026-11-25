-- Rolls back 20270202100000_fiscal_contingency_probe: the three columns go. `restored_at` was only the first instant the authority was seen
-- answering (the end the person or the probe gave is `ended_at`, which stays), so nothing legal is lost. Run it before the code that reads
-- them is brought back. Safe to run twice.
BEGIN;
ALTER TABLE "fiscal_contingencies" DROP COLUMN IF EXISTS "restored_at";
ALTER TABLE "fiscal_contingencies" DROP COLUMN IF EXISTS "probe_halted_at";
ALTER TABLE "fiscal_contingencies" DROP COLUMN IF EXISTS "technical_report_warned_at";
COMMIT;
