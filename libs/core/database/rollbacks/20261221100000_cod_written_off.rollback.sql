-- Rolls back 20261221100000_cod_written_off: a guide written off goes back to its discrepancy (the entry of the write-off stays in
-- the journal, which is immutable: a manual reversal by the accountant undoes it), then the old constraints come back.
BEGIN;

UPDATE shipments SET cod_status = 'discrepancy' WHERE cod_status = 'written_off';

ALTER TABLE shipments DROP CONSTRAINT chk_shipments_cod_remittance;
ALTER TABLE shipments ADD CONSTRAINT chk_shipments_cod_remittance CHECK (
  cod_remittance_id IS NULL OR cod_status IN ('remitted', 'discrepancy')
);

ALTER TABLE shipments DROP CONSTRAINT chk_shipments_cod_status;
ALTER TABLE shipments ADD CONSTRAINT chk_shipments_cod_status CHECK (cod_status IN (
  'not_applicable', 'not_delivered', 'pending_remittance', 'remitted', 'discrepancy', 'void'
));

COMMIT;
