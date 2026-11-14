-- The commission and the rate per service of a carrier connection (TDD_17 §4.15). Both are what the owner agreed with the carrier:
-- the commission is a percent of the cash collected (basis points: 450 is 4.5 %), the rates are cents by rate service of the carrier.
ALTER TABLE "carrier_connections" ADD COLUMN "commission_bps" INTEGER;
ALTER TABLE "carrier_connections" ADD COLUMN "service_rates_cents" JSONB;
ALTER TABLE "carrier_connections"
  ADD CONSTRAINT chk_carrier_connections_commission_bps CHECK (commission_bps IS NULL OR (commission_bps >= 0 AND commission_bps <= 5000)),
  ADD CONSTRAINT chk_carrier_connections_service_rates CHECK (service_rates_cents IS NULL OR jsonb_typeof(service_rates_cents) = 'object');

-- A guide keeps what the connection said when it was made, so editing the rates later never rewrites what a delivered guide should bring
ALTER TABLE "shipments" ADD COLUMN "carrier_rate_cents" INTEGER;
ALTER TABLE "shipments" ADD COLUMN "commission_bps" INTEGER;
ALTER TABLE "shipments"
  ADD CONSTRAINT chk_shipments_carrier_rate_cents CHECK (carrier_rate_cents IS NULL OR carrier_rate_cents >= 0),
  ADD CONSTRAINT chk_shipments_commission_bps CHECK (commission_bps IS NULL OR (commission_bps >= 0 AND commission_bps <= 5000));
