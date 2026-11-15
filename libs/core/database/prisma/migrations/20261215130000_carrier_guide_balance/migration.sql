-- The balance of prepaid guides and the refund benefit of a carrier connection (TDD_17 §4.18, Step 4.16). Everything is a setting
-- of the connection and off until a person turns it on; what a carrier does is to be confirmed with the carrier.

CREATE TABLE "carrier_guide_policies" (
  "connection_id" TEXT NOT NULL,
  "store_id" TEXT NOT NULL,
  "balance_enabled" BOOLEAN NOT NULL DEFAULT false,
  "benefit_enabled" BOOLEAN NOT NULL DEFAULT false,
  "warn_on_empty_balance" BOOLEAN NOT NULL DEFAULT true,
  "low_balance_threshold" INTEGER,
  "period_kind" TEXT NOT NULL DEFAULT 'fixed_days',
  "period_days" INTEGER NOT NULL DEFAULT 15,
  "period_anchor" TEXT NOT NULL,
  "threshold_bps" INTEGER NOT NULL DEFAULT 1000,
  "warn_at_bps" INTEGER NOT NULL DEFAULT 8000,
  "base" TEXT NOT NULL DEFAULT 'delivered',
  "return_statuses" TEXT[] DEFAULT ARRAY['returned']::TEXT[],
  "refund_rule" TEXT NOT NULL DEFAULT 'at_period_close',
  "loss_rule" TEXT NOT NULL DEFAULT 'from_crossing',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "carrier_guide_policies_pkey" PRIMARY KEY ("connection_id")
);
CREATE UNIQUE INDEX "carrier_guide_policies_store_id_connection_id_key" ON "carrier_guide_policies"("store_id", "connection_id");
CREATE INDEX "carrier_guide_policies_store_id_idx" ON "carrier_guide_policies"("store_id");
ALTER TABLE "carrier_guide_policies" ADD CONSTRAINT "carrier_guide_policies_store_id_fkey"
  FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "carrier_guide_policies" ADD CONSTRAINT "carrier_guide_policies_store_id_connection_id_fkey"
  FOREIGN KEY ("store_id", "connection_id") REFERENCES "carrier_connections"("store_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "carrier_guide_policies"
  ADD CONSTRAINT chk_carrier_guide_policies_period_kind CHECK (period_kind IN ('fixed_days', 'calendar_month', 'calendar_half_month')),
  ADD CONSTRAINT chk_carrier_guide_policies_period_days CHECK (period_days BETWEEN 1 AND 366),
  ADD CONSTRAINT chk_carrier_guide_policies_anchor CHECK (period_anchor ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  ADD CONSTRAINT chk_carrier_guide_policies_threshold CHECK (threshold_bps BETWEEN 1 AND 10000),
  ADD CONSTRAINT chk_carrier_guide_policies_warn CHECK (warn_at_bps BETWEEN 1 AND 10000),
  ADD CONSTRAINT chk_carrier_guide_policies_low CHECK (low_balance_threshold IS NULL OR low_balance_threshold >= 1),
  ADD CONSTRAINT chk_carrier_guide_policies_base CHECK (base IN ('created', 'dispatched', 'delivered')),
  ADD CONSTRAINT chk_carrier_guide_policies_refund_rule CHECK (refund_rule IN ('immediate', 'at_period_close')),
  ADD CONSTRAINT chk_carrier_guide_policies_loss_rule CHECK (loss_rule IN ('from_crossing', 'from_close')),
  ADD CONSTRAINT chk_carrier_guide_policies_combination CHECK (NOT (refund_rule = 'immediate' AND loss_rule = 'from_close')),
  ADD CONSTRAINT chk_carrier_guide_policies_return_statuses CHECK (cardinality(return_statuses) >= 1 AND return_statuses <@ ARRAY['returning', 'returned']::TEXT[]);

CREATE TABLE "carrier_guide_movements" (
  "id" TEXT NOT NULL,
  "store_id" TEXT NOT NULL,
  "connection_id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "guides_delta" INTEGER NOT NULL,
  "cost_cents_delta" INTEGER NOT NULL DEFAULT 0,
  "paid_quantity" INTEGER,
  "gift_quantity" INTEGER,
  "unit_cost_cents" INTEGER,
  "shipment_id" TEXT,
  "voids_movement_id" TEXT,
  "note" TEXT,
  "created_by" TEXT NOT NULL,
  "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "carrier_guide_movements_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "carrier_guide_movements_voids_movement_id_key" ON "carrier_guide_movements"("voids_movement_id");
CREATE UNIQUE INDEX "carrier_guide_movements_store_id_id_key" ON "carrier_guide_movements"("store_id", "id");
CREATE INDEX "carrier_guide_movements_connection_id_created_at_id_idx" ON "carrier_guide_movements"("connection_id", "created_at", "id");
CREATE INDEX "carrier_guide_movements_store_id_shipment_id_idx" ON "carrier_guide_movements"("store_id", "shipment_id");
ALTER TABLE "carrier_guide_movements" ADD CONSTRAINT "carrier_guide_movements_store_id_fkey"
  FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "carrier_guide_movements" ADD CONSTRAINT "carrier_guide_movements_store_id_connection_id_fkey"
  FOREIGN KEY ("store_id", "connection_id") REFERENCES "carrier_connections"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "carrier_guide_movements" ADD CONSTRAINT "carrier_guide_movements_store_id_shipment_id_fkey"
  FOREIGN KEY ("store_id", "shipment_id") REFERENCES "shipments"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "carrier_guide_movements" ADD CONSTRAINT "carrier_guide_movements_voids_movement_id_fkey"
  FOREIGN KEY ("voids_movement_id") REFERENCES "carrier_guide_movements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- What each kind of movement may hold, so a wrong row cannot be written by any code path
ALTER TABLE "carrier_guide_movements"
  ADD CONSTRAINT chk_carrier_guide_movements_kind CHECK (kind IN ('purchase', 'consume', 'refund', 'adjustment', 'void')),
  ADD CONSTRAINT chk_carrier_guide_movements_purchase CHECK (kind <> 'purchase' OR (
    paid_quantity IS NOT NULL AND gift_quantity IS NOT NULL AND paid_quantity >= 0 AND gift_quantity >= 0
    AND guides_delta = paid_quantity + gift_quantity AND guides_delta >= 1 AND cost_cents_delta >= 0
    AND shipment_id IS NULL AND voids_movement_id IS NULL)),
  ADD CONSTRAINT chk_carrier_guide_movements_consume CHECK (kind <> 'consume' OR (
    guides_delta = -1 AND cost_cents_delta = 0 AND shipment_id IS NOT NULL AND voids_movement_id IS NULL
    AND (unit_cost_cents IS NULL OR unit_cost_cents >= 0))),
  ADD CONSTRAINT chk_carrier_guide_movements_refund CHECK (kind <> 'refund' OR (
    guides_delta = 1 AND cost_cents_delta = 0 AND shipment_id IS NOT NULL AND voids_movement_id IS NULL)),
  ADD CONSTRAINT chk_carrier_guide_movements_adjustment CHECK (kind <> 'adjustment' OR (
    guides_delta <> 0 AND cost_cents_delta = 0 AND note IS NOT NULL AND shipment_id IS NULL AND voids_movement_id IS NULL)),
  ADD CONSTRAINT chk_carrier_guide_movements_void CHECK (kind <> 'void' OR (
    guides_delta < 0 AND cost_cents_delta <= 0 AND voids_movement_id IS NOT NULL AND note IS NOT NULL AND shipment_id IS NULL));

-- One guide consumed and one guide given back per shipment, whatever races to write it (a retried move, two workers)
CREATE UNIQUE INDEX carrier_guide_movements_one_per_shipment ON carrier_guide_movements (shipment_id, kind)
  WHERE kind IN ('consume', 'refund');

-- The ledger is append-only, as the journal of Step 4B.2: no UPDATE, DELETE or TRUNCATE by the application roles and none by
-- anyone else (the triggers refuse the owner of the table too). A correction is a new movement.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE carrier_guide_movements FROM platform_app, platform_worker;
CREATE FUNCTION forbid_carrier_guide_movement_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'CARRIER_GUIDE_LEDGER_IMMUTABLE: % of % is not allowed, the ledger of guides is append-only (write an adjustment instead)', TG_OP, TG_TABLE_NAME;
END $$;
CREATE TRIGGER trg_carrier_guide_movements_append_only BEFORE UPDATE OR DELETE ON carrier_guide_movements
  FOR EACH ROW EXECUTE FUNCTION forbid_carrier_guide_movement_change();
CREATE TRIGGER trg_carrier_guide_movements_no_truncate BEFORE TRUNCATE ON carrier_guide_movements
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_carrier_guide_movement_change();

CREATE TABLE "carrier_benefit_periods" (
  "id" TEXT NOT NULL,
  "store_id" TEXT NOT NULL,
  "connection_id" TEXT NOT NULL,
  "period_start" TIMESTAMP(3) NOT NULL,
  "period_end" TIMESTAMP(3) NOT NULL,
  "base_count" INTEGER NOT NULL,
  "return_count" INTEGER NOT NULL,
  "rate_bps" INTEGER NOT NULL,
  "state" TEXT NOT NULL,
  "refunded_count" INTEGER NOT NULL,
  "closed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "carrier_benefit_periods_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "carrier_benefit_periods_connection_id_period_start_key" ON "carrier_benefit_periods"("connection_id", "period_start");
CREATE INDEX "carrier_benefit_periods_store_id_connection_id_period_start_idx" ON "carrier_benefit_periods"("store_id", "connection_id", "period_start");
ALTER TABLE "carrier_benefit_periods" ADD CONSTRAINT "carrier_benefit_periods_store_id_fkey"
  FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "carrier_benefit_periods" ADD CONSTRAINT "carrier_benefit_periods_store_id_connection_id_fkey"
  FOREIGN KEY ("store_id", "connection_id") REFERENCES "carrier_connections"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "carrier_benefit_periods"
  ADD CONSTRAINT chk_carrier_benefit_periods_state CHECK (state IN ('in_force', 'at_risk', 'lost')),
  ADD CONSTRAINT chk_carrier_benefit_periods_counts CHECK (base_count >= 0 AND return_count >= 0 AND refunded_count >= 0 AND rate_bps >= 0),
  ADD CONSTRAINT chk_carrier_benefit_periods_range CHECK (period_end > period_start);

-- carriers:view_guide_balance and carriers:manage_guide_balance: the Admin role of every store holds every permission (RolePresets), so the
-- stores that exist get them as the ones made from now on do. No other role holds them: they show what the owner paid.
INSERT INTO "permissions" ("id", "name", "role_id")
SELECT gen_random_uuid()::text, p.name, r."id"
FROM "roles" r
CROSS JOIN (VALUES ('carriers:view_guide_balance'), ('carriers:manage_guide_balance')) AS p(name)
WHERE r."is_system" AND r."name" = 'Admin'
ON CONFLICT ("role_id", "name") DO NOTHING;
