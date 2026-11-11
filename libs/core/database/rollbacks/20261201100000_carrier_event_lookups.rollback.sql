BEGIN;

-- Safe to run twice. Only indexes: no data changes.
DROP INDEX IF EXISTS "shipment_events_unmapped_idx";
DROP INDEX IF EXISTS "shipments_connection_id_provider_shipment_id_idx";
DROP INDEX IF EXISTS "shipments_connection_id_guide_number_idx";

COMMIT;
