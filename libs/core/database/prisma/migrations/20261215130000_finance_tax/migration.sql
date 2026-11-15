-- Step 4B.3 (TDD_18 §7): the tax rates of the organization, the tax treatment of a product, the finance settings that decide
-- how tax is rounded and whether the shipping fee carries it, and the snapshot of the tax on an order and its lines. Every
-- column is additive and nullable or defaulted: an order made before this migration keeps NULL and is taxed at posting time.

-- AlterTable
ALTER TABLE "finance_settings" ADD COLUMN "tax_rounding" TEXT NOT NULL DEFAULT 'half_up',
ADD COLUMN "shipping_taxed" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "products" ADD COLUMN "tax_treatment" TEXT NOT NULL DEFAULT 'taxed',
ADD COLUMN "tax_rate_id" TEXT;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN "tax_cents" INTEGER,
ADD COLUMN "prices_include_tax" BOOLEAN,
ADD COLUMN "shipping_tax_rate_bps" INTEGER;

-- AlterTable
ALTER TABLE "order_items" ADD COLUMN "tax_treatment" TEXT,
ADD COLUMN "tax_rate_bps" INTEGER,
ADD COLUMN "tax_cents" INTEGER;

-- CreateTable
CREATE TABLE "tax_rates" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rate_bps" INTEGER NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'vat',
    "output_account_id" TEXT NOT NULL,
    "input_account_id" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tax_rates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tax_rates_organization_id_code_key" ON "tax_rates"("organization_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "tax_rates_organization_id_id_key" ON "tax_rates"("organization_id", "id");

-- CreateIndex
CREATE INDEX "products_tax_rate_id_idx" ON "products"("tax_rate_id");

-- AddForeignKey
ALTER TABLE "tax_rates" ADD CONSTRAINT "tax_rates_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_rates" ADD CONSTRAINT "tax_rates_organization_id_output_account_id_fkey" FOREIGN KEY ("organization_id", "output_account_id") REFERENCES "ledger_accounts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_rates" ADD CONSTRAINT "tax_rates_organization_id_input_account_id_fkey" FOREIGN KEY ("organization_id", "input_account_id") REFERENCES "ledger_accounts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_tax_rate_id_fkey" FOREIGN KEY ("tax_rate_id") REFERENCES "tax_rates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: the line of an entry that carries tax names a rate of its own organization (a NULL rate passes: MATCH SIMPLE)
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_organization_id_tax_rate_id_fkey" FOREIGN KEY ("organization_id", "tax_rate_id") REFERENCES "tax_rates"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================================================
-- What Prisma cannot say. The enums of these columns are TypeScript enums (libs/core/domain/finance-constants.ts); the CHECKs
-- below hold the same lists where a wrong value would break the tax of a sale (tests/api/finance-tax.spec.ts
-- compares the two).
-- ============================================================================================================
ALTER TABLE "finance_settings"
  ADD CONSTRAINT "finance_settings_tax_rounding_check" CHECK ("tax_rounding" IN ('half_up', 'half_even', 'down', 'up'));

ALTER TABLE "tax_rates"
  ADD CONSTRAINT "tax_rates_rate_bps_check" CHECK ("rate_bps" BETWEEN 0 AND 10000),
  ADD CONSTRAINT "tax_rates_kind_check" CHECK ("kind" IN ('vat')),
  -- The default rate is the one a product that names none is taxed at: a switched-off one would tax nothing
  ADD CONSTRAINT "tax_rates_default_active_check" CHECK (NOT "is_default" OR "active");

-- One default per organization
CREATE UNIQUE INDEX "tax_rates_one_default_per_organization" ON "tax_rates"("organization_id") WHERE "is_default";

ALTER TABLE "products"
  ADD CONSTRAINT "products_tax_treatment_check" CHECK ("tax_treatment" IN ('taxed', 'exempt', 'not_subject')),
  -- A rate of its own only makes sense for a taxed product
  ADD CONSTRAINT "products_tax_rate_taxed_check" CHECK ("tax_rate_id" IS NULL OR "tax_treatment" = 'taxed');

-- The rate a product names is one of the organization of the product's store: the composite keys cannot say that (a product
-- has a store, not an organization), so the database says it here, whatever route or script writes the row
CREATE FUNCTION check_product_tax_rate_organization() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.tax_rate_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM tax_rates r
    JOIN stores s ON s.organization_id = r.organization_id
    WHERE r.id = NEW.tax_rate_id AND s.id = NEW.store_id
  ) THEN
    RAISE EXCEPTION 'FINANCE_TAX_RATE_FOREIGN: the tax rate of a product must belong to the organization of its store'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_products_tax_rate_organization
  BEFORE INSERT OR UPDATE OF tax_rate_id, store_id ON products
  FOR EACH ROW EXECUTE FUNCTION check_product_tax_rate_organization();

-- The snapshot of an order is all there or all absent: an order made before this migration has none of it
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_tax_snapshot_check" CHECK (("tax_cents" IS NULL) = ("prices_include_tax" IS NULL)),
  ADD CONSTRAINT "orders_tax_cents_check" CHECK ("tax_cents" IS NULL OR "tax_cents" >= 0),
  ADD CONSTRAINT "orders_shipping_tax_rate_check" CHECK (
    "shipping_tax_rate_bps" IS NULL OR ("tax_cents" IS NOT NULL AND "shipping_tax_rate_bps" BETWEEN 0 AND 10000)
  );

ALTER TABLE "order_items"
  ADD CONSTRAINT "order_items_tax_treatment_check" CHECK ("tax_treatment" IS NULL OR "tax_treatment" IN ('taxed', 'exempt', 'not_subject')),
  ADD CONSTRAINT "order_items_tax_snapshot_check" CHECK (
    ("tax_treatment" IS NULL AND "tax_rate_bps" IS NULL AND "tax_cents" IS NULL)
    OR ("tax_treatment" = 'taxed' AND "tax_rate_bps" IS NOT NULL AND "tax_cents" IS NOT NULL AND "tax_rate_bps" BETWEEN 0 AND 10000 AND "tax_cents" >= 0)
    OR ("tax_treatment" IN ('exempt', 'not_subject') AND "tax_rate_bps" IS NULL AND "tax_cents" IS NOT NULL AND "tax_cents" = 0)
  );

-- A rate is never deleted (an order, a product and an entry name it): the application roles cannot, so a bug cannot take the default
-- away and leave every taxed product with no rate
REVOKE DELETE, TRUNCATE ON TABLE tax_rates FROM platform_app, platform_worker;

-- A column added to finance_settings has to be granted to the application roles by its own migration: the default is closed
-- (20261213110000_finance_ledger)
GRANT UPDATE ("tax_rounding", "shipping_taxed") ON TABLE finance_settings TO platform_app, platform_worker;

-- ============================================================================================================
-- The organizations that already have their books (country SV, the only template) get the rate the template seeds, so the
-- tax rates are not empty where the chart is not. The accounts are the ones their VAT roles already map. [ACCOUNTANT] 13 %
-- is the platform's working assumption (TDD_18 §7), editable like any rate. Safe to run twice.
-- ============================================================================================================
INSERT INTO "tax_rates" ("id", "organization_id", "code", "name", "rate_bps", "kind", "output_account_id", "input_account_id", "is_default", "updated_at")
SELECT gen_random_uuid()::text, s."organization_id", 'IVA', 'IVA 13 %', 1300, 'vat', o."account_id", i."account_id", true, CURRENT_TIMESTAMP
FROM "finance_settings" s
JOIN "account_role_mappings" o ON o."organization_id" = s."organization_id" AND o."role" = 'vat_output'
JOIN "account_role_mappings" i ON i."organization_id" = s."organization_id" AND i."role" = 'vat_input'
WHERE s."country_code" = 'SV'
ON CONFLICT DO NOTHING;
