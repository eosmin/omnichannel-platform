BEGIN;

-- Safe to run twice. Dropping the tables loses every remittance, draft or confirmed, and the line-by-line reconciliation
-- evidence: run it only together with the code that wrote them. The shipments keep their COD status, but a shipment that was
-- remitted or in discrepancy would then name a remittance that no longer exists, so those go back to waiting for one.
ALTER TABLE "shipments" DROP CONSTRAINT IF EXISTS chk_shipments_cod_remittance;
ALTER TABLE "shipments" DROP CONSTRAINT IF EXISTS "shipments_store_id_cod_remittance_id_fkey";
UPDATE "shipments"
SET cod_status = 'pending_remittance', cod_remitted_cents = NULL, cod_remittance_id = NULL
WHERE cod_status IN ('remitted', 'discrepancy');
UPDATE "shipments" SET cod_remittance_id = NULL WHERE cod_remittance_id IS NOT NULL;
DROP INDEX IF EXISTS shipments_guide_key;
DROP INDEX IF EXISTS "shipments_cod_remittance_id_idx";
DROP INDEX IF EXISTS "shipments_store_id_connection_id_cod_status_idx";
ALTER TABLE "shipments" DROP COLUMN IF EXISTS "delivered_at";
DROP TABLE IF EXISTS "cod_remittance_lines";
DROP TABLE IF EXISTS "cod_remittances";

COMMIT;
