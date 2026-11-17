-- Rolls back 20270116100000_finance_ledger_hardening_b: gives the application roles back the column privileges and drops the write-once guard
-- of the incident. Safe to run twice.
BEGIN;

DROP TRIGGER IF EXISTS trg_guard_finance_incident_resolution ON finance_chain_incidents;
DROP FUNCTION IF EXISTS guard_finance_incident_resolution();
GRANT UPDATE (resolved_at) ON TABLE finance_chain_incidents TO platform_app;
GRANT UPDATE (accounting_start_date, country_code, base_currency) ON TABLE finance_settings TO platform_app, platform_worker;

COMMIT;
