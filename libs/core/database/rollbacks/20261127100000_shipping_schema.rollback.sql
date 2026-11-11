-- Rolls back 20261127100000_shipping_schema. DESTRUCTIVE: every carrier connection (with its encrypted credentials and
-- webhook secret), service, guide sequence, shipment and its event history, status mapping, pickup, bulk label job,
-- order message template and return is DROPPED with its rows. Guides already created at a carrier stay at the carrier:
-- this script does not void them, and the guide numbers of a 'local' connection are lost with its sequence, so a
-- connection made again would number from the start. Take a copy of the tables first if their rows matter. Run it
-- before the code that reads them is brought back. Safe to run twice.
BEGIN;

DROP TRIGGER IF EXISTS trg_order_return_lines_belong_together ON order_return_lines;
DROP TRIGGER IF EXISTS trg_order_returns_scope ON order_returns;
DROP TRIGGER IF EXISTS trg_order_returns_belong_together ON order_returns;
DROP TRIGGER IF EXISTS trg_shipments_scope ON shipments;
DROP TRIGGER IF EXISTS trg_shipments_belong_together ON shipments;
DROP FUNCTION IF EXISTS check_order_return_line_belongs_together();
DROP FUNCTION IF EXISTS keep_order_return_scope();
DROP FUNCTION IF EXISTS check_order_return_belongs_together();
DROP FUNCTION IF EXISTS keep_shipment_scope();
DROP FUNCTION IF EXISTS check_shipment_belongs_together();

-- Shipments and returns point at each other, so the circle is cut before the tables go
ALTER TABLE IF EXISTS "order_returns" DROP CONSTRAINT IF EXISTS "order_returns_store_id_return_shipment_id_fkey";

DROP TABLE IF EXISTS "order_return_lines";
DROP TABLE IF EXISTS "shipment_events";
DROP TABLE IF EXISTS "shipments";
DROP TABLE IF EXISTS "order_returns";
DROP TABLE IF EXISTS "pickup_requests";
DROP TABLE IF EXISTS "carrier_unmapped_statuses";
DROP TABLE IF EXISTS "carrier_status_mappings";
DROP TABLE IF EXISTS "guide_sequences";
DROP TABLE IF EXISTS "carrier_services";
DROP TABLE IF EXISTS "carrier_connections";
DROP TABLE IF EXISTS "bulk_label_jobs";
DROP TABLE IF EXISTS "order_message_templates";

COMMIT;
