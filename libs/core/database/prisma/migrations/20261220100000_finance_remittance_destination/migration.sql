-- Step 4B.6b-1 (TDD_18 §4.2 E5): the account the owner chose on the confirm screen for the money of a remittance. Null means the
-- account of the role BANK_DEFAULT. A plain reference to the chart of accounts: the account belongs to the organization of the
-- store, which the api and the posting service check (the remittance has no organization column of its own to hold it in a key).
ALTER TABLE "cod_remittances" ADD COLUMN "destination_account_id" TEXT;

ALTER TABLE "cod_remittances"
  ADD CONSTRAINT "cod_remittances_destination_account_id_fkey"
  FOREIGN KEY ("destination_account_id") REFERENCES "ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "cod_remittances_destination_account_id_idx" ON "cod_remittances"("destination_account_id");
