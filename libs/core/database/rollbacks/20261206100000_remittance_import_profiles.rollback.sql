BEGIN;

-- Safe to run twice. The profiles are only how a settlement file is read: dropping them loses the saved mappings of the stores
-- (the remittances stay, and keep the id of a profile that is no longer there).
DROP INDEX IF EXISTS "cod_remittances_store_id_import_profile_id_idx";
DROP TABLE IF EXISTS "remittance_import_profiles";

COMMIT;
