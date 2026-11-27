-- What the annex of purchases of the monthly return needs of the supplier's document (D4b). A receipt is immutable (a trigger and a revoked
-- UPDATE: it is the record of what arrived and of what is owed), so the data of its document lives in a table of its own, one row for a
-- receipt, written with the receipt or after the fact by the staff. A receipt written before has no row: it is completed later, or marked
-- as left out of the annex. The values are the provider's codes (short text), so no country is written in the schema; the shape of the
-- text is bounded here and the provider validates the meaning when it is written.
CREATE TABLE "purchase_receipt_documents" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "receipt_id" TEXT NOT NULL,
    "document_class" TEXT,
    "document_type" TEXT,
    "generation_code" TEXT,
    "purchase_origin" TEXT,
    "expense_class" TEXT,
    "sector" TEXT,
    "cost_type" TEXT,
    "annex_exclusion" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_receipt_documents_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "chk_purchase_receipt_documents_codes" CHECK (
      (document_class IS NULL OR document_class ~ '^[0-9]{1,2}$')
      AND (document_type IS NULL OR document_type ~ '^[0-9]{1,2}$')
      AND (expense_class IS NULL OR expense_class ~ '^[0-9]{1,2}$')
      AND (sector IS NULL OR sector ~ '^[0-9]{1,2}$')
      AND (cost_type IS NULL OR cost_type ~ '^[0-9]{1,2}$')
    ),
    CONSTRAINT "chk_purchase_receipt_documents_generation_code" CHECK (
      generation_code IS NULL OR generation_code ~ '^[A-Za-z0-9-]{1,64}$'
    ),
    CONSTRAINT "chk_purchase_receipt_documents_origin" CHECK (
      purchase_origin IS NULL
      OR purchase_origin IN ('internal', 'internation', 'import_goods', 'import_services')
    ),
    CONSTRAINT "chk_purchase_receipt_documents_exclusion" CHECK (
      annex_exclusion IS NULL OR annex_exclusion IN ('excluded_subject', 'not_deductible')
    ),
    -- A row is either the data of a document or the mark that the annex leaves the receipt out, never both and never neither
    CONSTRAINT "chk_purchase_receipt_documents_either" CHECK (
      (annex_exclusion IS NOT NULL
        AND document_class IS NULL AND document_type IS NULL AND generation_code IS NULL AND purchase_origin IS NULL
        AND expense_class IS NULL AND sector IS NULL AND cost_type IS NULL)
      OR (annex_exclusion IS NULL
        AND document_class IS NOT NULL AND document_type IS NOT NULL AND purchase_origin IS NOT NULL
        AND expense_class IS NOT NULL AND sector IS NOT NULL AND cost_type IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "purchase_receipt_documents_organization_id_receipt_id_key"
    ON "purchase_receipt_documents"("organization_id", "receipt_id");
-- A received electronic document is on ONE receipt of the organization: the same one twice would be declared twice
CREATE UNIQUE INDEX "purchase_receipt_documents_organization_id_generation_code_key"
    ON "purchase_receipt_documents"("organization_id", "generation_code") WHERE "generation_code" IS NOT NULL;

ALTER TABLE "purchase_receipt_documents" ADD CONSTRAINT "purchase_receipt_documents_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_receipt_documents" ADD CONSTRAINT "purchase_receipt_documents_receipt_fkey"
    FOREIGN KEY ("organization_id", "receipt_id") REFERENCES "purchase_receipts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The application roles never delete a row: a document is replaced or marked, and the table never loses what was declared
REVOKE DELETE, TRUNCATE ON TABLE purchase_receipt_documents FROM platform_app, platform_worker;

-- The policy of a table of an organization (TDD_01 section 3.2, layer 3), declared here; it binds nobody until the owner turns enforcement on
SELECT rls_apply_policy('purchase_receipt_documents', 'organization');
