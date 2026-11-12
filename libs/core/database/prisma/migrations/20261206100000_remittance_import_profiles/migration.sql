-- CreateTable
CREATE TABLE "remittance_import_profiles" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "delimiter" TEXT NOT NULL DEFAULT ',',
    "has_header" BOOLEAN NOT NULL DEFAULT true,
    "decimal_separator" TEXT NOT NULL DEFAULT '.',
    "date_format" TEXT NOT NULL DEFAULT 'yyyy-MM-dd',
    "columns" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "remittance_import_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "remittance_import_profiles_store_id_id_key" ON "remittance_import_profiles"("store_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "remittance_import_profiles_connection_id_name_key" ON "remittance_import_profiles"("connection_id", "name");

-- AddForeignKey
ALTER TABLE "cod_remittances" ADD CONSTRAINT "cod_remittances_store_id_import_profile_id_fkey" FOREIGN KEY ("store_id", "import_profile_id") REFERENCES "remittance_import_profiles"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "remittance_import_profiles" ADD CONSTRAINT "remittance_import_profiles_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "remittance_import_profiles" ADD CONSTRAINT "remittance_import_profiles_store_id_connection_id_fkey" FOREIGN KEY ("store_id", "connection_id") REFERENCES "carrier_connections"("store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- The closed sets of a profile, and the shape of its columns: an object that names at least the guide and the amount
ALTER TABLE remittance_import_profiles
  ADD CONSTRAINT chk_remittance_import_profiles_delimiter CHECK (delimiter IN (',', ';', E'\t')),
  ADD CONSTRAINT chk_remittance_import_profiles_decimal CHECK (decimal_separator IN ('.', ',')),
  ADD CONSTRAINT chk_remittance_import_profiles_date_format CHECK (date_format IN ('yyyy-MM-dd', 'dd/MM/yyyy', 'MM/dd/yyyy', 'dd-MM-yyyy')),
  ADD CONSTRAINT chk_remittance_import_profiles_columns CHECK (
    jsonb_typeof(columns) = 'object' AND columns ? 'guideNumber' AND columns ? 'amount'
  ),
  ADD CONSTRAINT chk_remittance_import_profiles_name CHECK (btrim(name) <> '');
