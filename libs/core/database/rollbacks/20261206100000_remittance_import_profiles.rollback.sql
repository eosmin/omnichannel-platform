BEGIN;

-- Safe to run twice. The profiles are only how a settlement file is read: dropping them loses the saved mappings of the stores
-- (the remittances stay, and forget which profile made them).
ALTER TABLE "cod_remittances" DROP CONSTRAINT IF EXISTS "cod_remittances_store_id_import_profile_id_fkey";
UPDATE "cod_remittances" SET import_profile_id = NULL WHERE import_profile_id IS NOT NULL;
DROP TABLE IF EXISTS "remittance_import_profiles";

COMMIT;
