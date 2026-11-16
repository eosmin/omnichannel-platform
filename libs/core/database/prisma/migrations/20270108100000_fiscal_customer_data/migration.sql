-- Step 4B.7b-3 (TDD_18 §8): the fiscal data of a customer (tax id, registration, kind of taxpayer, economic activity, fiscal name and
-- address), kept sealed like the receiver of a fiscal document. Additive: a new table and two permissions, no existing row changes.
-- The document takes a COPY of this data when it is made (its own sealed receiver), so deleting or changing a row here never reaches a
-- document: the legal evidence does not depend on this table.

CREATE TABLE "customer_fiscal_data" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "data_encrypted" BYTEA NOT NULL,
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_fiscal_data_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "customer_fiscal_data_customer_id_key" ON "customer_fiscal_data"("customer_id");
CREATE INDEX "customer_fiscal_data_store_id_idx" ON "customer_fiscal_data"("store_id");

ALTER TABLE "customer_fiscal_data" ADD CONSTRAINT "customer_fiscal_data_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "customer_fiscal_data" ADD CONSTRAINT "customer_fiscal_data_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The sealed value is never empty (a customer with no fiscal data has no row)
ALTER TABLE "customer_fiscal_data" ADD CONSTRAINT chk_customer_fiscal_data_not_empty CHECK (octet_length("data_encrypted") > 0);

-- The row belongs to the store of its customer, on insert and on update: a row can never carry another store's id
CREATE FUNCTION customer_fiscal_data_scope() RETURNS trigger
SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM customers c WHERE c.id = NEW.customer_id AND c.store_id = NEW.store_id) THEN
    RAISE EXCEPTION 'the fiscal data of a customer belongs to the store of the customer' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_customer_fiscal_data_scope
  BEFORE INSERT OR UPDATE OF store_id, customer_id ON customer_fiscal_data
  FOR EACH ROW EXECUTE FUNCTION customer_fiscal_data_scope();

-- The Admin role of every store holds every permission (RolePresets), so the stores that exist get the two new ones as the ones made
-- from now on do. No other role holds them: it is personal and tax data (TDD_18 §9.1).
INSERT INTO "permissions" ("id", "name", "role_id")
SELECT gen_random_uuid()::text, p.name, r."id"
FROM "roles" r
CROSS JOIN (VALUES ('fiscal:view_customer_data'), ('fiscal:manage_customer_data')) AS p(name)
WHERE r."is_system" AND r."name" = 'Admin'
ON CONFLICT ("role_id", "name") DO NOTHING;
