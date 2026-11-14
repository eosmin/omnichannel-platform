BEGIN;

-- Safe to run twice. The columns only hold what the owner agreed with a carrier and what a guide kept of it: dropping them
-- returns every expected remittance amount to the gross-or-reported-cost rule the old code has. Amounts already written to
-- shipments.cod_expected_cents stay as they were written.
ALTER TABLE "shipments" DROP CONSTRAINT IF EXISTS chk_shipments_commission_bps;
ALTER TABLE "shipments" DROP CONSTRAINT IF EXISTS chk_shipments_carrier_rate_cents;
ALTER TABLE "shipments" DROP COLUMN IF EXISTS "commission_bps";
ALTER TABLE "shipments" DROP COLUMN IF EXISTS "carrier_rate_cents";
ALTER TABLE "carrier_connections" DROP CONSTRAINT IF EXISTS chk_carrier_connections_service_rates;
ALTER TABLE "carrier_connections" DROP CONSTRAINT IF EXISTS chk_carrier_connections_commission_bps;
ALTER TABLE "carrier_connections" DROP COLUMN IF EXISTS "service_rates_cents";
ALTER TABLE "carrier_connections" DROP COLUMN IF EXISTS "commission_bps";

COMMIT;
