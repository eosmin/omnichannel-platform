-- LED-R2-040: the accounting start date and the country of the books are set once, when the books are set up (the setup only creates them).
-- An application taken over must not move them: no role of the application may update either column. A correction goes through the
-- migration role.
REVOKE UPDATE (accounting_start_date, country_code) ON TABLE finance_settings FROM platform_app, platform_worker;

-- LED-516: only the weekly job (platform_worker) may close a chain incident. The API role keeps the columns a check moves and loses resolved_at.
REVOKE UPDATE (resolved_at) ON TABLE finance_chain_incidents FROM platform_app;

-- resolved_at is written once: NULL to a value no earlier than detected_at; never changed, never cleared (an incident closed stays closed;
-- a new alteration opens a new incident)
CREATE FUNCTION guard_finance_incident_resolution() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.resolved_at IS NOT NULL AND NEW.resolved_at IS DISTINCT FROM OLD.resolved_at THEN
    RAISE EXCEPTION 'a closed finance chain incident cannot be reopened or changed' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.resolved_at IS NOT NULL AND NEW.resolved_at < NEW.detected_at THEN
    RAISE EXCEPTION 'a finance chain incident cannot be closed before it was detected' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_guard_finance_incident_resolution
  BEFORE UPDATE ON finance_chain_incidents
  FOR EACH ROW EXECUTE FUNCTION guard_finance_incident_resolution();
