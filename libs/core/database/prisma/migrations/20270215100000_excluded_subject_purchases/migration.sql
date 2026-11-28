-- D20b: purchases from an excluded subject (a seller who is not a taxpayer of the VAT, paid against an invoice that the buyer issues: article
-- 119 of the Tax Code). The record is the buyer's, one row for a purchase with its concepts, and it is the source of the annex of the monthly
-- return that declares them. Like a receipt it is immutable (a trigger and a revoked UPDATE and DELETE): a mistake is answered by a new record,
-- never by an edit of what could already be declared. The codes are the provider's (short text, bounded here, meant by the provider).
-- The seller is a natural person with no relation to the store: the number of the identity document and the name are SEALED with the platform
-- key (`seller_encrypted`, like the receiver of a fiscal document), and the re-seal of a rotation of the key swaps them through
-- `fiscal_reseal_excluded_subject`. Only the type of the document (a code) is in the clear.
-- Rollback: rollbacks/20270215100000_excluded_subject_purchases.rollback.sql
CREATE TABLE "excluded_subject_purchases" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "client_key" TEXT NOT NULL,
    "purchased_on" DATE NOT NULL,
    "seller_document_type" TEXT NOT NULL,
    "seller_encrypted" BYTEA NOT NULL,
    "document_series" TEXT,
    "generation_code" TEXT,
    "amount_cents" INTEGER NOT NULL,
    "vat_withheld_cents" INTEGER NOT NULL,
    -- The income tax the buyer withheld: computed from the concepts by the service, stated every time, and with NO default: a purchase that
    -- does not say it is not written (a silent zero would be a wrong declaration that nobody sees)
    "income_tax_withheld_cents" INTEGER NOT NULL,
    "operation_type" TEXT NOT NULL,
    "expense_class" TEXT NOT NULL,
    "sector" TEXT NOT NULL,
    "cost_type" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC'),

    CONSTRAINT "excluded_subject_purchases_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "chk_excluded_subject_purchases_amounts" CHECK (
      amount_cents > 0 AND amount_cents <= 999999999
      AND vat_withheld_cents >= 0 AND vat_withheld_cents <= amount_cents
      AND income_tax_withheld_cents >= 0 AND income_tax_withheld_cents <= amount_cents
    ),
    CONSTRAINT "chk_excluded_subject_purchases_codes" CHECK (
      seller_document_type ~ '^[0-9]{1,2}$' AND operation_type ~ '^[0-9]{1,2}$' AND expense_class ~ '^[0-9]{1,2}$'
      AND sector ~ '^[0-9]{1,2}$' AND cost_type ~ '^[0-9]{1,2}$'
    ),
    CONSTRAINT "chk_excluded_subject_purchases_seller" CHECK (fiscal_reseal_shape_ok(seller_encrypted)),
    -- The seal of reception and the code of generation of the electronic document go together or are both missing
    CONSTRAINT "chk_excluded_subject_purchases_document" CHECK (
      (document_series IS NULL AND generation_code IS NULL)
      OR (document_series IS NOT NULL AND generation_code IS NOT NULL
        AND length(document_series) BETWEEN 1 AND 100 AND generation_code ~ '^[A-Za-z0-9-]{1,64}$')
    )
);

CREATE TABLE "excluded_subject_purchase_lines" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "purchase_id" TEXT NOT NULL,
    "line_no" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,

    CONSTRAINT "excluded_subject_purchase_lines_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "chk_excluded_subject_purchase_lines_kind" CHECK (kind IN ('goods', 'service')),
    CONSTRAINT "chk_excluded_subject_purchase_lines_amount" CHECK (amount_cents > 0 AND amount_cents <= 999999999),
    CONSTRAINT "chk_excluded_subject_purchase_lines_description" CHECK (length(description) BETWEEN 1 AND 200)
);

CREATE UNIQUE INDEX "excluded_subject_purchases_organization_id_id_key"
    ON "excluded_subject_purchases"("organization_id", "id");
CREATE UNIQUE INDEX "excluded_subject_purchases_organization_id_client_key_key"
    ON "excluded_subject_purchases"("organization_id", "client_key");
-- An electronic invoice is on ONE purchase of the organization: the same one twice would be declared twice
CREATE UNIQUE INDEX "excluded_subject_purchases_organization_id_generation_code_key"
    ON "excluded_subject_purchases"("organization_id", "generation_code") WHERE "generation_code" IS NOT NULL;
-- The month of an annex reads the purchases of an organization by their day
CREATE INDEX "excluded_subject_purchases_organization_id_purchased_on_idx"
    ON "excluded_subject_purchases"("organization_id", "purchased_on");
CREATE UNIQUE INDEX "excluded_subject_purchase_lines_purchase_id_line_no_key"
    ON "excluded_subject_purchase_lines"("purchase_id", "line_no");
CREATE INDEX "excluded_subject_purchase_lines_organization_id_purchase_id_idx"
    ON "excluded_subject_purchase_lines"("organization_id", "purchase_id");

ALTER TABLE "excluded_subject_purchases" ADD CONSTRAINT "excluded_subject_purchases_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "excluded_subject_purchase_lines" ADD CONSTRAINT "excluded_subject_purchase_lines_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "excluded_subject_purchase_lines" ADD CONSTRAINT "excluded_subject_purchase_lines_organization_id_purchase_id_fkey"
    FOREIGN KEY ("organization_id", "purchase_id") REFERENCES "excluded_subject_purchases"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- What is paid is the sum of the concepts, checked when the transaction ends (the concepts are written after the header, in one transaction)
CREATE FUNCTION check_excluded_subject_purchase_total() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
DECLARE
  total bigint;
BEGIN
  SELECT COALESCE(SUM(amount_cents), 0) INTO total FROM excluded_subject_purchase_lines
    WHERE purchase_id = NEW.id AND organization_id = NEW.organization_id;
  IF total <> NEW.amount_cents THEN
    RAISE EXCEPTION 'EXCLUDED_SUBJECT_TOTAL: the amount of a purchase is the sum of its concepts';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER trg_excluded_subject_purchases_total
AFTER INSERT ON excluded_subject_purchases
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION check_excluded_subject_purchase_total();

-- The same check from the side of the concepts: a concept added to a purchase that was committed before makes the sum differ from the amount, and the
-- transaction that adds it fails when it ends (the header is immutable, so the amount cannot be moved to meet the concept)
CREATE FUNCTION check_excluded_subject_purchase_lines_total() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
DECLARE
  total bigint;
  expected integer;
BEGIN
  SELECT amount_cents INTO expected FROM excluded_subject_purchases
    WHERE id = NEW.purchase_id AND organization_id = NEW.organization_id;
  SELECT COALESCE(SUM(amount_cents), 0) INTO total FROM excluded_subject_purchase_lines
    WHERE purchase_id = NEW.purchase_id AND organization_id = NEW.organization_id;
  IF expected IS NULL OR total <> expected THEN
    RAISE EXCEPTION 'EXCLUDED_SUBJECT_TOTAL: the amount of a purchase is the sum of its concepts';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER trg_excluded_subject_purchase_lines_total
AFTER INSERT ON excluded_subject_purchase_lines
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION check_excluded_subject_purchase_lines_total();

-- A purchase and its concepts are never changed or deleted: what could have been declared stays as it was. The ONE exception is the re-seal of a
-- rotation of the key: the function below sets the flag of the fiscal guard for its own statement and the guard lets through an update that
-- changes the sealed seller and no other column; the door is the one of the fiscal guards (the setting AND the owner of the re-seal functions), and the
-- roles of the application hold no UPDATE anyway.
CREATE FUNCTION guard_excluded_subject_purchase() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF public.fiscal_reseal_door_open() THEN
      IF (NEW.id, NEW.organization_id, NEW.client_key, NEW.purchased_on, NEW.seller_document_type, NEW.document_series, NEW.generation_code,
          NEW.amount_cents, NEW.vat_withheld_cents, NEW.income_tax_withheld_cents, NEW.operation_type, NEW.expense_class, NEW.sector,
          NEW.cost_type, NEW.created_by, NEW.created_at)
         IS NOT DISTINCT FROM
         (OLD.id, OLD.organization_id, OLD.client_key, OLD.purchased_on, OLD.seller_document_type, OLD.document_series, OLD.generation_code,
          OLD.amount_cents, OLD.vat_withheld_cents, OLD.income_tax_withheld_cents, OLD.operation_type, OLD.expense_class, OLD.sector,
          OLD.cost_type, OLD.created_by, OLD.created_at) THEN
        RETURN NEW;
      END IF;
    END IF;
  END IF;
  RAISE EXCEPTION 'EXCLUDED_SUBJECT_IMMUTABLE: a purchase from an excluded subject is never changed or deleted';
END $$;

CREATE FUNCTION forbid_excluded_subject_purchase_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'EXCLUDED_SUBJECT_IMMUTABLE: a purchase from an excluded subject is never changed or deleted';
END $$;

CREATE TRIGGER trg_excluded_subject_purchases_immutable
BEFORE UPDATE OR DELETE ON excluded_subject_purchases
FOR EACH ROW EXECUTE FUNCTION guard_excluded_subject_purchase();
CREATE TRIGGER trg_excluded_subject_purchases_no_truncate
BEFORE TRUNCATE ON excluded_subject_purchases
FOR EACH STATEMENT EXECUTE FUNCTION forbid_excluded_subject_purchase_change();
CREATE TRIGGER trg_excluded_subject_purchase_lines_immutable
BEFORE UPDATE OR DELETE ON excluded_subject_purchase_lines
FOR EACH ROW EXECUTE FUNCTION forbid_excluded_subject_purchase_change();
CREATE TRIGGER trg_excluded_subject_purchase_lines_no_truncate
BEFORE TRUNCATE ON excluded_subject_purchase_lines
FOR EACH STATEMENT EXECUTE FUNCTION forbid_excluded_subject_purchase_change();

-- The re-seal of the sealed seller of one purchase, in one statement that the guard recognises (the same door as `fiscal_reseal_void_event`). The
-- caller (the worker) has opened the old value, sealed it again with the current key and checked that the new one opens to the same content; the
-- swap is compare-and-swap (the old bytes are in the WHERE), so a row that changed meanwhile is left alone and the call says so.
CREATE FUNCTION fiscal_reseal_excluded_subject(p_organization_id text, p_id text, p_old bytea, p_new bytea) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    changed integer;
  BEGIN
    IF p_organization_id IS NULL OR NOT (p_organization_id = ANY (public.app_organization_ids())) THEN
      RAISE EXCEPTION 'the organization is not in the context of the caller' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF p_old IS NULL OR NOT public.fiscal_reseal_shape_ok(p_new) THEN
      RAISE EXCEPTION 'a re-seal needs a sealed seller' USING ERRCODE = 'check_violation';
    END IF;
    PERFORM pg_catalog.set_config('app.fiscal_reseal', 'on', true);
    UPDATE public.excluded_subject_purchases
       SET seller_encrypted = p_new
     WHERE id = p_id AND organization_id = p_organization_id AND seller_encrypted = p_old;
    GET DIAGNOSTICS changed = ROW_COUNT;
    PERFORM pg_catalog.set_config('app.fiscal_reseal', 'off', true);
    RETURN changed = 1;
  END
  $$;
REVOKE EXECUTE ON FUNCTION fiscal_reseal_excluded_subject(text, text, bytea, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fiscal_reseal_excluded_subject(text, text, bytea, bytea) TO platform_worker;

-- The application adds them and reads them; the worker only reads: nothing it runs writes a purchase
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE excluded_subject_purchases, excluded_subject_purchase_lines FROM platform_app, platform_worker;
REVOKE INSERT ON TABLE excluded_subject_purchases, excluded_subject_purchase_lines FROM platform_worker;

-- The policy of a table of an organization (TDD_01 section 3.2, layer 3), declared here; it binds nobody until the owner turns enforcement on
SELECT rls_apply_policy('excluded_subject_purchases', 'organization');
SELECT rls_apply_policy('excluded_subject_purchase_lines', 'organization');
