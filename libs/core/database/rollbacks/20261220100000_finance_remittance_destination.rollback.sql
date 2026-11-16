-- Rolls back 20261220100000_finance_remittance_destination. DESTRUCTIVE only for the column: the destination account each confirmed
-- remittance recorded is dropped (the journal entries that used it stay, the journal is append-only). Safe to run twice.
BEGIN;
DROP TRIGGER IF EXISTS trg_cod_remittances_destination ON cod_remittances;
DROP FUNCTION IF EXISTS check_remittance_destination();
DROP INDEX IF EXISTS "cod_remittances_destination_account_id_idx";
ALTER TABLE "cod_remittances" DROP CONSTRAINT IF EXISTS "cod_remittances_destination_account_id_fkey";
ALTER TABLE "cod_remittances" DROP COLUMN IF EXISTS "destination_account_id";
COMMIT;
