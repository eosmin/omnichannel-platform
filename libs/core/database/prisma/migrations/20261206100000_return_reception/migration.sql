-- CreateTable
CREATE TABLE "return_reception_batches" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processing_started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "return_reception_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "return_reception_items" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "batch_id" TEXT NOT NULL,
    "shipment_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "condition" TEXT NOT NULL DEFAULT 'resellable',
    "note" TEXT,
    "lines" JSONB NOT NULL DEFAULT '[]',
    "flag_customer" BOOLEAN NOT NULL DEFAULT false,
    "flag_reason" TEXT,
    "outcome" TEXT,
    "error_code" TEXT,
    "return_id" TEXT,
    "flag_applied_at" TIMESTAMP(3),
    "scanned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "return_reception_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "return_reception_batches_store_id_id_key" ON "return_reception_batches"("store_id", "id");

-- CreateIndex
CREATE INDEX "return_reception_batches_store_id_status_idx" ON "return_reception_batches"("store_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "return_reception_items_batch_id_shipment_id_key" ON "return_reception_items"("batch_id", "shipment_id");

-- CreateIndex
CREATE INDEX "return_reception_items_store_id_shipment_id_idx" ON "return_reception_items"("store_id", "shipment_id");

-- CreateIndex
CREATE INDEX "return_reception_items_store_id_return_id_idx" ON "return_reception_items"("store_id", "return_id");

-- AddForeignKey
ALTER TABLE "return_reception_batches" ADD CONSTRAINT "return_reception_batches_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_reception_items" ADD CONSTRAINT "return_reception_items_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_reception_items" ADD CONSTRAINT "return_reception_items_store_id_batch_id_fkey" FOREIGN KEY ("store_id", "batch_id") REFERENCES "return_reception_batches"("store_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_reception_items" ADD CONSTRAINT "return_reception_items_store_id_shipment_id_fkey" FOREIGN KEY ("store_id", "shipment_id") REFERENCES "shipments"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_reception_items" ADD CONSTRAINT "return_reception_items_store_id_return_id_fkey" FOREIGN KEY ("store_id", "return_id") REFERENCES "order_returns"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The closed sets and the shape of a row (the same style as the shipping tables)
ALTER TABLE return_reception_batches
  ADD CONSTRAINT chk_return_reception_batches_status CHECK (status IN ('draft', 'processing', 'completed', 'completed_with_errors')),
  -- A claim has its time, and only a claim has it
  ADD CONSTRAINT chk_return_reception_batches_claim CHECK ((status = 'processing') = (processing_started_at IS NOT NULL)),
  ADD CONSTRAINT chk_return_reception_batches_completed CHECK ((completed_at IS NOT NULL) = (status IN ('completed', 'completed_with_errors')));

ALTER TABLE return_reception_items
  ADD CONSTRAINT chk_return_reception_items_condition CHECK (condition IN ('resellable', 'defective', 'damaged')),
  ADD CONSTRAINT chk_return_reception_items_outcome CHECK (outcome IS NULL OR outcome IN ('received', 'failed')),
  ADD CONSTRAINT chk_return_reception_items_lines CHECK (jsonb_typeof(lines) = 'array'),
  -- A package that was received has its return and one that failed says why. A received one may still carry a code: the flag
  -- of its customer could not be applied (the batch is retried for that)
  ADD CONSTRAINT chk_return_reception_items_result CHECK (
    (outcome IS NOT DISTINCT FROM 'received') = (return_id IS NOT NULL)
    AND (outcome IS NOT NULL OR error_code IS NULL)
    AND (outcome IS DISTINCT FROM 'failed' OR error_code IS NOT NULL)
  ),
  -- The reason to flag a customer is only kept when the customer is to be flagged
  ADD CONSTRAINT chk_return_reception_items_flag CHECK (flag_customer OR (flag_reason IS NULL AND flag_applied_at IS NULL));

-- A package comes back once: the database refuses a second received reception of the same shipment, whatever batch it is in
CREATE UNIQUE INDEX return_reception_items_received_shipment_key
  ON return_reception_items (store_id, shipment_id) WHERE outcome = 'received';

-- The lookup by guide number ignores the case and the blanks (TDD_17 §4.16)
CREATE INDEX shipments_store_guide_normalized_idx
  ON shipments (store_id, lower(regexp_replace(guide_number, '[[:space:]]', '', 'g')));
