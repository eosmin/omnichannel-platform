-- Step 4B.6b-2 (TDD_18 §4.2 E7): a person can write off the difference of a guide that did not match its remittance. The guide
-- gets its own terminal status, and keeps the name of the remittance that left the difference (the evidence of what was written off).
ALTER TABLE shipments DROP CONSTRAINT chk_shipments_cod_status;
ALTER TABLE shipments ADD CONSTRAINT chk_shipments_cod_status CHECK (cod_status IN (
  'not_applicable', 'not_delivered', 'pending_remittance', 'remitted', 'discrepancy', 'written_off', 'void'
));

ALTER TABLE shipments DROP CONSTRAINT chk_shipments_cod_remittance;
ALTER TABLE shipments ADD CONSTRAINT chk_shipments_cod_remittance CHECK (
  cod_remittance_id IS NULL OR cod_status IN ('remitted', 'discrepancy', 'written_off')
);
