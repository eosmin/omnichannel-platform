-- Step 4.8 PR B1: the shipping tables of TDD_17 §2 and §4.17 (carrier connections, services, guide sequences, shipments,
-- their events, status mappings, pickups, bulk label jobs, order message templates, returns). Additive: twelve new tables,
-- nothing existing is changed (the foreign key Order.carrierConnectionId is Step 4.8 PR C1; the reception tables are 4.12,
-- the remittance tables 4.13).

-- CreateTable
CREATE TABLE "carrier_connections" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "carrier_id" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "credentials" BYTEA,
    "webhook_secret" BYTEA,
    "default_service_code" TEXT,
    "default_shipping_payer" TEXT NOT NULL DEFAULT 'sender',
    "label_format" TEXT NOT NULL DEFAULT 'pdf_100x150',
    "contact" JSONB,
    "pickup_enabled" BOOLEAN NOT NULL DEFAULT false,
    "pickup_days" INTEGER[] DEFAULT ARRAY[1, 2, 3, 4, 5]::INTEGER[],
    "pickup_cutoff_time" TEXT,
    "auto_pickup" BOOLEAN NOT NULL DEFAULT false,
    "auto_pickup_time" TEXT,
    "pickup_reminder_minutes" INTEGER NOT NULL DEFAULT 30,
    "poll_interval_minutes" INTEGER,
    "max_delivery_attempts" INTEGER NOT NULL DEFAULT 3,
    "default_shipping_fee_cents" INTEGER,
    "min_shipping_fee_cents" INTEGER,
    "max_shipping_fee_cents" INTEGER,
    "remittance_deducts_fee" BOOLEAN NOT NULL DEFAULT false,
    "last_healthy_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "carrier_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "carrier_services" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "carrier_services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guide_sequences" (
    "connection_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "next_value" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "guide_sequences_pkey" PRIMARY KEY ("connection_id")
);

-- CreateTable
CREATE TABLE "shipments" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'outbound',
    "return_id" TEXT,
    "origin_warehouse_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'creating',
    "service_code" TEXT NOT NULL,
    "shipping_payer" TEXT NOT NULL,
    "cod_amount_cents" INTEGER,
    "cod_status" TEXT NOT NULL DEFAULT 'not_applicable',
    "cod_expected_cents" INTEGER,
    "cod_remitted_cents" INTEGER,
    "cod_remittance_id" TEXT,
    "currency" TEXT NOT NULL,
    "package_count" INTEGER NOT NULL DEFAULT 1,
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "weight_grams" INTEGER,
    "guide_number" TEXT,
    "provider_shipment_id" TEXT,
    "tracking_url" TEXT,
    "label_media_id" TEXT,
    "carrier_cost_cents" INTEGER,
    "refund_status" TEXT NOT NULL DEFAULT 'not_applicable',
    "idempotency_key" TEXT NOT NULL,
    "pickup_id" TEXT,
    "last_error" TEXT,
    "cancel_requested_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipment_events" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "shipment_id" TEXT NOT NULL,
    "provider_event_id" TEXT,
    "status" TEXT,
    "raw_status" TEXT,
    "description" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL,
    "payload" JSONB,

    CONSTRAINT "shipment_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "carrier_status_mappings" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "provider_code" TEXT NOT NULL,
    "label" TEXT,
    "status" TEXT,
    "source" TEXT NOT NULL DEFAULT 'default',
    "updated_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "carrier_status_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "carrier_unmapped_statuses" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "provider_code" TEXT NOT NULL,
    "sample_raw_status" TEXT NOT NULL,
    "sample_description" TEXT,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "carrier_unmapped_statuses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pickup_requests" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "pickup_date" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "package_count" INTEGER NOT NULL DEFAULT 0,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "provider_pickup_id" TEXT,
    "window_start" TEXT,
    "window_end" TEXT,
    "requested_by" TEXT NOT NULL,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pickup_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bulk_label_jobs" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "order_ids" TEXT[],
    "total" INTEGER NOT NULL,
    "succeeded" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "results" JSONB,
    "merged_media_id" TEXT,
    "requested_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "bulk_label_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_message_templates" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "auto_send" BOOLEAN NOT NULL DEFAULT false,
    "attach_summary" BOOLEAN NOT NULL DEFAULT false,
    "channel_template" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_message_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_returns" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "shipping_payer" TEXT NOT NULL,
    "replacement_order_id" TEXT,
    "return_shipment_id" TEXT,
    "refund_amount_cents" INTEGER,
    "notes" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "received_at" TIMESTAMP(3),

    CONSTRAINT "order_returns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_return_lines" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "return_id" TEXT NOT NULL,
    "order_item_id" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "condition" TEXT,
    "restock_warehouse_id" TEXT,

    CONSTRAINT "order_return_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "carrier_connections_store_id_status_idx" ON "carrier_connections"("store_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "carrier_connections_store_id_display_name_key" ON "carrier_connections"("store_id", "display_name");

-- CreateIndex
CREATE UNIQUE INDEX "carrier_connections_store_id_id_key" ON "carrier_connections"("store_id", "id");

-- CreateIndex
CREATE INDEX "carrier_services_store_id_idx" ON "carrier_services"("store_id");

-- CreateIndex
CREATE UNIQUE INDEX "carrier_services_connection_id_code_key" ON "carrier_services"("connection_id", "code");

-- CreateIndex
CREATE INDEX "guide_sequences_store_id_idx" ON "guide_sequences"("store_id");

-- CreateIndex
CREATE UNIQUE INDEX "guide_sequences_store_id_connection_id_key" ON "guide_sequences"("store_id", "connection_id");

-- CreateIndex
CREATE INDEX "shipments_order_id_idx" ON "shipments"("order_id");

-- CreateIndex
CREATE INDEX "shipments_store_id_status_idx" ON "shipments"("store_id", "status");

-- CreateIndex
CREATE INDEX "shipments_store_id_order_id_idx" ON "shipments"("store_id", "order_id");

-- CreateIndex
CREATE INDEX "shipments_connection_id_status_idx" ON "shipments"("connection_id", "status");

-- CreateIndex
CREATE INDEX "shipments_pickup_id_idx" ON "shipments"("pickup_id");

-- CreateIndex
CREATE INDEX "shipments_origin_warehouse_id_idx" ON "shipments"("origin_warehouse_id");

-- CreateIndex
CREATE INDEX "shipments_return_id_idx" ON "shipments"("return_id");

-- CreateIndex
CREATE UNIQUE INDEX "shipments_store_id_id_key" ON "shipments"("store_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "shipments_store_id_idempotency_key_key" ON "shipments"("store_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "shipment_events_shipment_id_occurred_at_idx" ON "shipment_events"("shipment_id", "occurred_at");

-- CreateIndex
CREATE INDEX "shipment_events_store_id_idx" ON "shipment_events"("store_id");

-- CreateIndex
CREATE INDEX "carrier_status_mappings_store_id_idx" ON "carrier_status_mappings"("store_id");

-- CreateIndex
CREATE UNIQUE INDEX "carrier_status_mappings_connection_id_provider_code_key" ON "carrier_status_mappings"("connection_id", "provider_code");

-- CreateIndex
CREATE INDEX "carrier_unmapped_statuses_store_id_idx" ON "carrier_unmapped_statuses"("store_id");

-- CreateIndex
CREATE UNIQUE INDEX "carrier_unmapped_statuses_connection_id_provider_code_key" ON "carrier_unmapped_statuses"("connection_id", "provider_code");

-- CreateIndex
CREATE INDEX "pickup_requests_store_id_pickup_date_idx" ON "pickup_requests"("store_id", "pickup_date");

-- CreateIndex
CREATE INDEX "pickup_requests_connection_id_idx" ON "pickup_requests"("connection_id");

-- CreateIndex
CREATE UNIQUE INDEX "pickup_requests_store_id_id_key" ON "pickup_requests"("store_id", "id");

-- CreateIndex
CREATE INDEX "bulk_label_jobs_store_id_created_at_idx" ON "bulk_label_jobs"("store_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "order_message_templates_store_id_kind_locale_key" ON "order_message_templates"("store_id", "kind", "locale");

-- CreateIndex
CREATE INDEX "order_returns_order_id_idx" ON "order_returns"("order_id");

-- CreateIndex
CREATE INDEX "order_returns_store_id_order_id_idx" ON "order_returns"("store_id", "order_id");

-- CreateIndex
CREATE INDEX "order_returns_store_id_status_idx" ON "order_returns"("store_id", "status");

-- CreateIndex
CREATE INDEX "order_returns_replacement_order_id_idx" ON "order_returns"("replacement_order_id");

-- CreateIndex
CREATE INDEX "order_returns_return_shipment_id_idx" ON "order_returns"("return_shipment_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_returns_store_id_id_key" ON "order_returns"("store_id", "id");

-- CreateIndex
CREATE INDEX "order_return_lines_store_id_idx" ON "order_return_lines"("store_id");

-- CreateIndex
CREATE INDEX "order_return_lines_order_item_id_idx" ON "order_return_lines"("order_item_id");

-- CreateIndex
CREATE INDEX "order_return_lines_restock_warehouse_id_idx" ON "order_return_lines"("restock_warehouse_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_return_lines_return_id_order_item_id_key" ON "order_return_lines"("return_id", "order_item_id");

-- AddForeignKey
ALTER TABLE "carrier_connections" ADD CONSTRAINT "carrier_connections_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_services" ADD CONSTRAINT "carrier_services_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_services" ADD CONSTRAINT "carrier_services_store_id_connection_id_fkey" FOREIGN KEY ("store_id", "connection_id") REFERENCES "carrier_connections"("store_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guide_sequences" ADD CONSTRAINT "guide_sequences_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guide_sequences" ADD CONSTRAINT "guide_sequences_store_id_connection_id_fkey" FOREIGN KEY ("store_id", "connection_id") REFERENCES "carrier_connections"("store_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_store_id_connection_id_fkey" FOREIGN KEY ("store_id", "connection_id") REFERENCES "carrier_connections"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_store_id_pickup_id_fkey" FOREIGN KEY ("store_id", "pickup_id") REFERENCES "pickup_requests"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_origin_warehouse_id_fkey" FOREIGN KEY ("origin_warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_store_id_return_id_fkey" FOREIGN KEY ("store_id", "return_id") REFERENCES "order_returns"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_events" ADD CONSTRAINT "shipment_events_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_events" ADD CONSTRAINT "shipment_events_store_id_shipment_id_fkey" FOREIGN KEY ("store_id", "shipment_id") REFERENCES "shipments"("store_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_status_mappings" ADD CONSTRAINT "carrier_status_mappings_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_status_mappings" ADD CONSTRAINT "carrier_status_mappings_store_id_connection_id_fkey" FOREIGN KEY ("store_id", "connection_id") REFERENCES "carrier_connections"("store_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_unmapped_statuses" ADD CONSTRAINT "carrier_unmapped_statuses_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_unmapped_statuses" ADD CONSTRAINT "carrier_unmapped_statuses_store_id_connection_id_fkey" FOREIGN KEY ("store_id", "connection_id") REFERENCES "carrier_connections"("store_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pickup_requests" ADD CONSTRAINT "pickup_requests_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pickup_requests" ADD CONSTRAINT "pickup_requests_store_id_connection_id_fkey" FOREIGN KEY ("store_id", "connection_id") REFERENCES "carrier_connections"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bulk_label_jobs" ADD CONSTRAINT "bulk_label_jobs_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_message_templates" ADD CONSTRAINT "order_message_templates_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_returns" ADD CONSTRAINT "order_returns_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_returns" ADD CONSTRAINT "order_returns_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_returns" ADD CONSTRAINT "order_returns_replacement_order_id_fkey" FOREIGN KEY ("replacement_order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_returns" ADD CONSTRAINT "order_returns_store_id_return_shipment_id_fkey" FOREIGN KEY ("store_id", "return_shipment_id") REFERENCES "shipments"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_return_lines" ADD CONSTRAINT "order_return_lines_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_return_lines" ADD CONSTRAINT "order_return_lines_store_id_return_id_fkey" FOREIGN KEY ("store_id", "return_id") REFERENCES "order_returns"("store_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_return_lines" ADD CONSTRAINT "order_return_lines_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_return_lines" ADD CONSTRAINT "order_return_lines_restock_warehouse_id_fkey" FOREIGN KEY ("restock_warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------------------------------------------
-- Raw SQL (what Prisma cannot declare)
-- ---------------------------------------------------------------------------------------------------------------

-- One active outbound guide per order and origin warehouse (TDD_17 §2). NULLS NOT DISTINCT: an order with no warehouse
-- is still limited to one. A new guide for the same order and warehouse is possible only after the previous one is
-- 'cancelled' or 'failed'; while it is 'cancel_pending' or 'cancel_failed' the index refuses it (§4.8).
CREATE UNIQUE INDEX shipments_one_active_outbound ON shipments (order_id, origin_warehouse_id) NULLS NOT DISTINCT
  WHERE kind = 'outbound' AND status NOT IN ('cancelled', 'failed');

-- A guide number is the carrier's own: unique within the connection
CREATE UNIQUE INDEX shipments_guide_per_connection ON shipments (connection_id, guide_number)
  WHERE guide_number IS NOT NULL;

-- A carrier event is delivered more than once: the same provider event id is stored once per shipment
CREATE UNIQUE INDEX shipment_events_provider_dedupe ON shipment_events (shipment_id, provider_event_id)
  WHERE provider_event_id IS NOT NULL;

-- The columns that hold a STATE (the ones a service moves through a state machine) mirror the enums of
-- libs/core/domain/status-enums.ts, and tests/security/shipping-schema.spec.ts compares each set with its enum, so a value
-- added to one and not the other fails there. The open sets (label_format, order_message_templates.kind, order_returns.reason,
-- carrier_id) are validated by Zod and the plugins, so that a private plugin or a new template kind needs no migration.
ALTER TABLE carrier_connections
  ADD CONSTRAINT chk_carrier_connections_status CHECK (status IN ('active', 'disabled', 'error')),
  ADD CONSTRAINT chk_carrier_connections_payer CHECK (default_shipping_payer IN ('sender', 'recipient')),
  ADD CONSTRAINT chk_carrier_connections_names CHECK (btrim(carrier_id) <> '' AND btrim(display_name) <> ''),
  -- 'local' has no carrier account, so nothing to encrypt
  ADD CONSTRAINT chk_carrier_connections_local_credentials CHECK (carrier_id <> 'local' OR (credentials IS NULL AND webhook_secret IS NULL)),
  ADD CONSTRAINT chk_carrier_connections_pickup_days CHECK (pickup_days IS NOT NULL AND pickup_days <@ ARRAY[1, 2, 3, 4, 5, 6, 7]),
  ADD CONSTRAINT chk_carrier_connections_times CHECK (
    (pickup_cutoff_time IS NULL OR pickup_cutoff_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
    AND (auto_pickup_time IS NULL OR auto_pickup_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
  ),
  ADD CONSTRAINT chk_carrier_connections_auto_pickup CHECK (NOT auto_pickup OR (pickup_enabled AND auto_pickup_time IS NOT NULL)),
  -- A connection that takes pickups has at least one day to take them
  ADD CONSTRAINT chk_carrier_connections_pickup_enabled CHECK (NOT pickup_enabled OR cardinality(pickup_days) >= 1),
  ADD CONSTRAINT chk_carrier_connections_counts CHECK (
    pickup_reminder_minutes >= 0 AND max_delivery_attempts >= 1 AND (poll_interval_minutes IS NULL OR poll_interval_minutes >= 1)
  ),
  -- The shipping fee charged to the customer: each value is a money amount and min <= default <= max when set (§4.13)
  ADD CONSTRAINT chk_carrier_connections_fee CHECK (
    (default_shipping_fee_cents IS NULL OR default_shipping_fee_cents >= 0)
    AND (min_shipping_fee_cents IS NULL OR min_shipping_fee_cents >= 0)
    AND (max_shipping_fee_cents IS NULL OR max_shipping_fee_cents >= 0)
    AND (min_shipping_fee_cents IS NULL OR max_shipping_fee_cents IS NULL OR min_shipping_fee_cents <= max_shipping_fee_cents)
    AND (min_shipping_fee_cents IS NULL OR default_shipping_fee_cents IS NULL OR min_shipping_fee_cents <= default_shipping_fee_cents)
    AND (default_shipping_fee_cents IS NULL OR max_shipping_fee_cents IS NULL OR default_shipping_fee_cents <= max_shipping_fee_cents)
  );

ALTER TABLE carrier_services
  ADD CONSTRAINT chk_carrier_services_text CHECK (btrim(code) <> '' AND btrim(label) <> '');

ALTER TABLE guide_sequences
  -- Printed in front of the number and read into a barcode: letters, digits and dashes, at most eight
  ADD CONSTRAINT chk_guide_sequences_prefix CHECK (prefix ~ '^[A-Za-z0-9-]{0,8}$'),
  ADD CONSTRAINT chk_guide_sequences_next CHECK (next_value >= 1);

ALTER TABLE shipments
  ADD CONSTRAINT chk_shipments_kind CHECK (kind IN ('outbound', 'return')),
  ADD CONSTRAINT chk_shipments_status CHECK (status IN (
    'creating', 'label_created', 'picked_up', 'in_transit', 'out_for_delivery', 'failed_attempt', 'delivered',
    'returning', 'returned', 'cancel_pending', 'cancelled', 'cancel_failed', 'requires_review', 'failed'
  )),
  ADD CONSTRAINT chk_shipments_payer CHECK (shipping_payer IN ('sender', 'recipient')),
  ADD CONSTRAINT chk_shipments_refund_status CHECK (refund_status IN ('not_applicable', 'pending', 'confirmed', 'not_supported')),
  ADD CONSTRAINT chk_shipments_cod_status CHECK (cod_status IN (
    'not_applicable', 'not_delivered', 'pending_remittance', 'remitted', 'discrepancy', 'void'
  )),
  -- A prepaid shipment (no COD amount) has no cash to collect, and a COD one always has a COD state (§4.4, §4.15)
  ADD CONSTRAINT chk_shipments_cod_pair CHECK ((cod_amount_cents IS NULL) = (cod_status = 'not_applicable')),
  -- A return shipment names its return, and only a return shipment does (§4.11)
  ADD CONSTRAINT chk_shipments_return_pair CHECK ((kind = 'return') = (return_id IS NOT NULL)),
  ADD CONSTRAINT chk_shipments_amounts CHECK (
    (cod_amount_cents IS NULL OR cod_amount_cents >= 0)
    AND (cod_expected_cents IS NULL OR cod_expected_cents >= 0)
    AND (cod_remitted_cents IS NULL OR cod_remitted_cents >= 0)
    AND (carrier_cost_cents IS NULL OR carrier_cost_cents >= 0)
  ),
  ADD CONSTRAINT chk_shipments_counts CHECK (
    package_count >= 1 AND failed_attempts >= 0 AND (weight_grams IS NULL OR weight_grams > 0)
  ),
  ADD CONSTRAINT chk_shipments_text CHECK (
    currency ~ '^[A-Z]{3}$' AND btrim(service_code) <> '' AND btrim(idempotency_key) <> '' AND btrim(created_by) <> ''
  );

ALTER TABLE shipment_events
  ADD CONSTRAINT chk_shipment_events_source CHECK (source IN ('webhook', 'poll', 'manual', 'system')),
  ADD CONSTRAINT chk_shipment_events_status CHECK (status IS NULL OR status IN (
    'creating', 'label_created', 'picked_up', 'in_transit', 'out_for_delivery', 'failed_attempt', 'delivered',
    'returning', 'returned', 'cancel_pending', 'cancelled', 'cancel_failed', 'requires_review', 'failed'
  ));

ALTER TABLE carrier_status_mappings
  ADD CONSTRAINT chk_carrier_status_mappings_source CHECK (source IN ('default', 'custom')),
  ADD CONSTRAINT chk_carrier_status_mappings_code CHECK (btrim(provider_code) <> ''),
  -- A carrier can only report these (CarrierReportableStatuses); null = ignore on purpose
  ADD CONSTRAINT chk_carrier_status_mappings_status CHECK (status IS NULL OR status IN (
    'label_created', 'picked_up', 'in_transit', 'out_for_delivery', 'failed_attempt', 'delivered', 'returning',
    'returned', 'cancelled'
  ));

ALTER TABLE carrier_unmapped_statuses
  ADD CONSTRAINT chk_carrier_unmapped_statuses_code CHECK (btrim(provider_code) <> ''),
  ADD CONSTRAINT chk_carrier_unmapped_statuses_occurrences CHECK (occurrences >= 1);

ALTER TABLE pickup_requests
  ADD CONSTRAINT chk_pickup_requests_status CHECK (status IN (
    'pending', 'requires_review', 'requested', 'confirmed', 'manual_required', 'cancelled', 'failed'
  )),
  ADD CONSTRAINT chk_pickup_requests_counts CHECK (package_count >= 0 AND revision >= 1),
  -- The window is both ends or none, as 'HH:mm', and it opens before it closes
  ADD CONSTRAINT chk_pickup_requests_window CHECK (
    (window_start IS NULL) = (window_end IS NULL)
    AND (window_start IS NULL OR (
      window_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND window_end ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND window_start < window_end
    ))
  );

ALTER TABLE bulk_label_jobs
  ADD CONSTRAINT chk_bulk_label_jobs_status CHECK (status IN ('queued', 'running', 'completed', 'completed_with_errors', 'failed')),
  ADD CONSTRAINT chk_bulk_label_jobs_counts CHECK (
    order_ids IS NOT NULL AND total >= 1 AND succeeded >= 0 AND failed >= 0 AND succeeded + failed <= total AND cardinality(order_ids) = total
  ),
  -- A job that is still queued or running has not finished
  ADD CONSTRAINT chk_bulk_label_jobs_finished CHECK ((status IN ('queued', 'running')) = (finished_at IS NULL)),
  -- A job that finished by itself accounted for every order, and says whether any failed
  ADD CONSTRAINT chk_bulk_label_jobs_outcome CHECK (
    status NOT IN ('completed', 'completed_with_errors')
    OR (succeeded + failed = total AND (failed = 0) = (status = 'completed'))
  );

ALTER TABLE order_message_templates
  ADD CONSTRAINT chk_order_message_templates_text CHECK (btrim(kind) <> '' AND char_length(locale) BETWEEN 2 AND 10 AND btrim(body) <> '');

ALTER TABLE order_returns
  ADD CONSTRAINT chk_order_returns_type CHECK (type IN ('refund', 'exchange')),
  ADD CONSTRAINT chk_order_returns_status CHECK (status IN (
    'requested', 'approved', 'in_transit', 'received', 'completed', 'rejected', 'cancelled'
  )),
  ADD CONSTRAINT chk_order_returns_payer CHECK (shipping_payer IN ('sender', 'recipient')),
  ADD CONSTRAINT chk_order_returns_amount CHECK (refund_amount_cents IS NULL OR refund_amount_cents >= 0),
  -- Only an exchange has a replacement order, and it is never the order that is returned
  ADD CONSTRAINT chk_order_returns_replacement CHECK (
    replacement_order_id IS NULL OR (type = 'exchange' AND replacement_order_id <> order_id)
  );

ALTER TABLE order_return_lines
  ADD CONSTRAINT chk_order_return_lines_quantity CHECK (quantity >= 1),
  ADD CONSTRAINT chk_order_return_lines_condition CHECK (condition IS NULL OR condition IN ('resellable', 'defective', 'damaged'));

-- ---------------------------------------------------------------------------------------------------------------
-- What the composite foreign keys cannot say. Order, OrderItem and Warehouse have no (store_id, id) key to point at,
-- so a plain foreign key reaches them and these triggers check that the row reached is of the same store (or of the
-- organization of the store). Whoever writes, for every insert and every change of those columns.
-- ---------------------------------------------------------------------------------------------------------------

CREATE FUNCTION check_shipment_belongs_together() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = NEW.order_id AND o.store_id = NEW.store_id) THEN
    RAISE EXCEPTION 'the order of a shipment is not an order of the store of the shipment'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'shipment_order_of_store';
  END IF;
  IF NEW.origin_warehouse_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM warehouses w JOIN stores s ON s.organization_id = w.organization_id
    WHERE w.id = NEW.origin_warehouse_id AND s.id = NEW.store_id
  ) THEN
    RAISE EXCEPTION 'the origin warehouse of a shipment is not a warehouse of the organization of its store'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'shipment_warehouse_of_organization';
  END IF;
  IF NEW.return_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM order_returns r WHERE r.id = NEW.return_id AND r.order_id = NEW.order_id
  ) THEN
    RAISE EXCEPTION 'the return of a shipment is not a return of the order of the shipment'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'shipment_return_of_order';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_shipments_belong_together
  BEFORE INSERT OR UPDATE OF store_id, order_id, origin_warehouse_id, return_id ON shipments
  FOR EACH ROW EXECUTE FUNCTION check_shipment_belongs_together();

-- A shipment never moves to another store, order, connection, kind, origin warehouse or return: its guide, label and history were made for them
CREATE FUNCTION keep_shipment_scope() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.store_id IS DISTINCT FROM OLD.store_id
     OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.connection_id IS DISTINCT FROM OLD.connection_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR (OLD.origin_warehouse_id IS NOT NULL AND NEW.origin_warehouse_id IS DISTINCT FROM OLD.origin_warehouse_id)
     OR NEW.return_id IS DISTINCT FROM OLD.return_id THEN
    RAISE EXCEPTION 'the store, order, connection, kind and return of a shipment, and its origin warehouse once set, are never changed'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'shipment_scope_frozen';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_shipments_scope
  BEFORE UPDATE OF store_id, order_id, connection_id, kind, origin_warehouse_id, return_id ON shipments
  FOR EACH ROW EXECUTE FUNCTION keep_shipment_scope();

CREATE FUNCTION check_order_return_belongs_together() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = NEW.order_id AND o.store_id = NEW.store_id) THEN
    RAISE EXCEPTION 'the order of a return is not an order of the store of the return'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'return_order_of_store';
  END IF;
  IF NEW.replacement_order_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM orders o WHERE o.id = NEW.replacement_order_id AND o.store_id = NEW.store_id
  ) THEN
    RAISE EXCEPTION 'the replacement order of a return is not an order of the store of the return'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'return_replacement_of_store';
  END IF;
  -- The return shipment is the one made for this return, in the return direction
  IF NEW.return_shipment_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM shipments s WHERE s.id = NEW.return_shipment_id AND s.kind = 'return' AND s.return_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'the return shipment of a return is not a return shipment made for it'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'return_shipment_of_return';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_order_returns_belong_together
  BEFORE INSERT OR UPDATE OF store_id, order_id, replacement_order_id, return_shipment_id ON order_returns
  FOR EACH ROW EXECUTE FUNCTION check_order_return_belongs_together();

CREATE FUNCTION keep_order_return_scope() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.store_id IS DISTINCT FROM OLD.store_id OR NEW.order_id IS DISTINCT FROM OLD.order_id OR NEW.type IS DISTINCT FROM OLD.type THEN
    RAISE EXCEPTION 'the store, order and type of a return are never changed'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'return_scope_frozen';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_order_returns_scope
  BEFORE UPDATE OF store_id, order_id, type ON order_returns
  FOR EACH ROW EXECUTE FUNCTION keep_order_return_scope();

-- A returned line is a line of the order that is returned, and the warehouse that restocks it is one of the organization
CREATE FUNCTION check_order_return_line_belongs_together() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM order_returns r JOIN order_items i ON i.order_id = r.order_id
    WHERE r.id = NEW.return_id AND i.id = NEW.order_item_id
  ) THEN
    RAISE EXCEPTION 'the item of a return line is not an item of the order that is returned'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'return_line_item_of_order';
  END IF;
  IF NEW.restock_warehouse_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM warehouses w JOIN stores s ON s.organization_id = w.organization_id
    WHERE w.id = NEW.restock_warehouse_id AND s.id = NEW.store_id
  ) THEN
    RAISE EXCEPTION 'the restock warehouse of a return line is not a warehouse of the organization of its store'
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'return_line_warehouse_of_organization';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_order_return_lines_belong_together
  BEFORE INSERT OR UPDATE OF return_id, store_id, order_item_id, restock_warehouse_id ON order_return_lines
  FOR EACH ROW EXECUTE FUNCTION check_order_return_line_belongs_together();
