-- The package count the carrier last acknowledged for a pickup (TDD_17 §4.10): the count of the pickup is recomputed from its
-- guides, and a pickup the carrier holds is told again until the two agree. A pickup made before this column keeps null: it is
-- taken as "the carrier has what we have" until it changes.
ALTER TABLE "pickup_requests" ADD COLUMN "carrier_package_count" INTEGER;
