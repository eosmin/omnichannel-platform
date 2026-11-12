-- AlterTable
ALTER TABLE "shipments" ADD COLUMN     "delivered_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "cod_remittances" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "reference" TEXT,
    "received_on" DATE,
    "import_profile_id" TEXT,
    "source_media_id" TEXT,
    "expected_cents" INTEGER NOT NULL DEFAULT 0,
    "reported_cents" INTEGER NOT NULL DEFAULT 0,
    "fee_cents" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_at" TIMESTAMP(3),
    "confirmed_by" TEXT,
    "voided_at" TIMESTAMP(3),
    "voided_by" TEXT,

    CONSTRAINT "cod_remittances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cod_remittance_lines" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "remittance_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "shipment_id" TEXT,
    "guide_number" TEXT NOT NULL,
    "reported_cents" INTEGER NOT NULL,
    "reported_fee_cents" INTEGER,
    "expected_cents" INTEGER,
    "outcome" TEXT NOT NULL,
    "excluded" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,

    CONSTRAINT "cod_remittance_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cod_remittances_store_id_connection_id_status_idx" ON "cod_remittances"("store_id", "connection_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "cod_remittances_store_id_id_key" ON "cod_remittances"("store_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "cod_remittance_lines_remittance_id_position_key" ON "cod_remittance_lines"("remittance_id", "position");

-- CreateIndex
CREATE INDEX "cod_remittance_lines_shipment_id_idx" ON "cod_remittance_lines"("shipment_id");

-- CreateIndex
CREATE INDEX "shipments_store_id_connection_id_cod_status_idx" ON "shipments"("store_id", "connection_id", "cod_status");

-- CreateIndex
CREATE INDEX "shipments_cod_remittance_id_idx" ON "shipments"("cod_remittance_id");

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_store_id_cod_remittance_id_fkey" FOREIGN KEY ("store_id", "cod_remittance_id") REFERENCES "cod_remittances"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cod_remittances" ADD CONSTRAINT "cod_remittances_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cod_remittances" ADD CONSTRAINT "cod_remittances_store_id_connection_id_fkey" FOREIGN KEY ("store_id", "connection_id") REFERENCES "carrier_connections"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cod_remittance_lines" ADD CONSTRAINT "cod_remittance_lines_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cod_remittance_lines" ADD CONSTRAINT "cod_remittance_lines_store_id_remittance_id_fkey" FOREIGN KEY ("store_id", "remittance_id") REFERENCES "cod_remittances"("store_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cod_remittance_lines" ADD CONSTRAINT "cod_remittance_lines_store_id_shipment_id_fkey" FOREIGN KEY ("store_id", "shipment_id") REFERENCES "shipments"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- The closed sets and the shape of a row (the open sets of TDD_17 §2 carry a CHECK, as the shipping tables do)
ALTER TABLE cod_remittances
  ADD CONSTRAINT chk_cod_remittances_status CHECK (status IN ('draft', 'confirmed', 'voided')),
  -- A draft has no confirmation, a confirmed one has it, and only a confirmed one can have been voided
  ADD CONSTRAINT chk_cod_remittances_lifecycle CHECK (
    (status = 'draft' AND confirmed_at IS NULL AND voided_at IS NULL)
    OR (status = 'confirmed' AND confirmed_at IS NOT NULL AND confirmed_by IS NOT NULL AND voided_at IS NULL)
    OR (status = 'voided' AND confirmed_at IS NOT NULL AND voided_at IS NOT NULL AND voided_by IS NOT NULL)
  ),
  ADD CONSTRAINT chk_cod_remittances_amounts CHECK (expected_cents >= 0 AND reported_cents >= 0 AND fee_cents >= 0);

ALTER TABLE cod_remittance_lines
  ADD CONSTRAINT chk_cod_remittance_lines_outcome CHECK (outcome IN (
    'matched', 'amount_differs', 'not_found', 'not_delivered', 'already_remitted', 'duplicate_in_file'
  )),
  ADD CONSTRAINT chk_cod_remittance_lines_amounts CHECK (
    position >= 1 AND reported_cents >= 0 AND (reported_fee_cents IS NULL OR reported_fee_cents >= 0) AND (expected_cents IS NULL OR expected_cents >= 0)
  ),
  -- A line that matched nothing names no shipment, and every other one (a repeated guide aside) names the shipment it was held against
  ADD CONSTRAINT chk_cod_remittance_lines_shipment CHECK (
    (outcome = 'not_found' AND shipment_id IS NULL)
    OR outcome = 'duplicate_in_file'
    OR (outcome NOT IN ('not_found', 'duplicate_in_file') AND shipment_id IS NOT NULL)
  ),
  ADD CONSTRAINT chk_cod_remittance_lines_guide CHECK (btrim(guide_number) <> '');

-- A shipment names the remittance that settled it only while it is remitted or in discrepancy: a void must clear both
ALTER TABLE shipments
  ADD CONSTRAINT chk_shipments_cod_remittance CHECK (
    cod_remittance_id IS NULL OR cod_status IN ('remitted', 'discrepancy')
  );

-- Shipments delivered before this step were already waiting for a remittance with no expected amount and no day of delivery:
-- the amount is rebuilt from the connection's fee rule (§4.15) and the day from the history of the shipment
UPDATE shipments s
SET cod_expected_cents = CASE
  WHEN c.remittance_deducts_fee AND s.shipping_payer = 'sender' AND s.carrier_cost_cents IS NOT NULL
    THEN GREATEST(0, s.cod_amount_cents - s.carrier_cost_cents)
  ELSE s.cod_amount_cents
END
FROM carrier_connections c
WHERE c.id = s.connection_id AND c.store_id = s.store_id
  AND s.cod_status = 'pending_remittance' AND s.cod_expected_cents IS NULL AND s.cod_amount_cents IS NOT NULL;

UPDATE shipments s
SET delivered_at = (
  SELECT min(e.occurred_at) FROM shipment_events e WHERE e.shipment_id = s.id AND e.status = 'delivered'
)
WHERE s.status = 'delivered' AND s.delivered_at IS NULL;
