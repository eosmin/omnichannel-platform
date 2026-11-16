-- Step 4B.6b-1 (TDD_18 §4.2 E5): the account the owner chose on the confirm screen for the money of a remittance. Null means the
-- account of the role BANK_DEFAULT. A plain reference to the chart of accounts: the account belongs to the organization of the
-- store, which the api and the posting service check (the remittance has no organization column of its own to hold it in a key).
ALTER TABLE "cod_remittances" ADD COLUMN "destination_account_id" TEXT;

ALTER TABLE "cod_remittances"
  ADD CONSTRAINT "cod_remittances_destination_account_id_fkey"
  FOREIGN KEY ("destination_account_id") REFERENCES "ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "cod_remittances_destination_account_id_idx" ON "cod_remittances"("destination_account_id");

-- A remittance has no organization column to hold the account in a composite key, so the database holds the tenancy rule itself: the
-- account belongs to the organization of the store of the remittance.
CREATE OR REPLACE FUNCTION check_remittance_destination() RETURNS trigger AS $$
BEGIN
  IF NEW.destination_account_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM ledger_accounts a JOIN stores s ON s.organization_id = a.organization_id
    WHERE a.id = NEW.destination_account_id AND s.id = NEW.store_id
  ) THEN
    RAISE EXCEPTION 'the destination account of a remittance belongs to the organization of its store'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_cod_remittances_destination
  BEFORE INSERT OR UPDATE OF destination_account_id ON cod_remittances
  FOR EACH ROW EXECUTE FUNCTION check_remittance_destination();
