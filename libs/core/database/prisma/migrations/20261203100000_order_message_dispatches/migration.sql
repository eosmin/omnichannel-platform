-- The key the records that hang from an order point at (a composite foreign key keeps them in the store of the order)
CREATE UNIQUE INDEX "orders_store_id_id_key" ON "orders"("store_id", "id");

-- CreateTable
CREATE TABLE "order_message_dispatches" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "reason" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "message_id" TEXT,
    "shipment_id" TEXT,
    "requested_by" TEXT,
    "locale" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_message_dispatches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "order_message_dispatches_store_id_idempotency_key_key" ON "order_message_dispatches"("store_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "order_message_dispatches_store_id_order_id_created_at_idx" ON "order_message_dispatches"("store_id", "order_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "order_message_dispatches" ADD CONSTRAINT "order_message_dispatches_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_message_dispatches" ADD CONSTRAINT "order_message_dispatches_store_id_order_id_fkey" FOREIGN KEY ("store_id", "order_id") REFERENCES "orders"("store_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The closed sets (the open sets of TDD_17 §2 carry a CHECK, as the shipping tables do) and the shape of a row: a message that
-- did not go says why, and one that went has no reason
ALTER TABLE order_message_dispatches
  ADD CONSTRAINT chk_order_message_dispatches_kind CHECK (kind IN (
    'order_summary', 'order_shipped', 'order_out_for_delivery', 'order_delivered', 'order_failed_attempt', 'order_cancelled',
    'return_approved', 'exchange_shipped'
  )),
  ADD CONSTRAINT chk_order_message_dispatches_trigger CHECK (trigger IN ('automatic', 'manual')),
  ADD CONSTRAINT chk_order_message_dispatches_route CHECK (route IN ('channel_text', 'channel_template', 'email', 'not_sent')),
  ADD CONSTRAINT chk_order_message_dispatches_reason CHECK (
    (route = 'not_sent') = (reason IS NOT NULL)
    AND (reason IS NULL OR reason IN (
      'missing_variable', 'too_long', 'no_template', 'no_channel', 'window_closed', 'template_unavailable', 'customer_erased',
      'consent_revoked'
    ))
  ),
  ADD CONSTRAINT chk_order_message_dispatches_key CHECK (btrim(idempotency_key) <> '');
