-- Rolls back 20270107100000_finance_chain_incidents. DESTRUCTIVE: it drops the record of the alterations of the chain that the weekly check
-- found; the check finds them again on its next run. Safe to run twice.
BEGIN;
DROP TABLE IF EXISTS finance_chain_incidents;
COMMIT;
