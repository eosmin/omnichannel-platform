-- LED-R2-040: the accounting start date, the country and the base currency of the books are set once, when the books are set up (the setup
-- only creates them). An application taken over must not move them: no role of the application may update them. A correction goes through
-- the migration role.
REVOKE UPDATE (accounting_start_date, country_code, base_currency) ON TABLE finance_settings FROM platform_app, platform_worker;

-- LED-516: only the weekly job (platform_worker) may close a chain incident. The API role keeps the columns a check moves and loses resolved_at.
REVOKE UPDATE (resolved_at) ON TABLE finance_chain_incidents FROM platform_app;

-- resolved_at is written once by the roles of the application: a closed incident is never reopened or moved by them (a new alteration opens
-- a new incident). The owner of the database keeps the way to correct a mistake. A close is never dated before the detection: the clocks of
-- two processes may disagree by a few milliseconds, so the database moves it up to the detection instead of refusing the close.
CREATE FUNCTION guard_finance_incident_resolution() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.resolved_at IS NOT NULL
     AND NEW.resolved_at IS DISTINCT FROM OLD.resolved_at
     AND current_user IN ('platform_app', 'platform_worker') THEN
    RAISE EXCEPTION 'a closed finance chain incident cannot be reopened or changed' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.resolved_at IS NULL AND NEW.resolved_at IS NOT NULL THEN
    NEW.resolved_at := GREATEST(NEW.resolved_at, NEW.detected_at);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_guard_finance_incident_resolution
  BEFORE UPDATE ON finance_chain_incidents
  FOR EACH ROW EXECUTE FUNCTION guard_finance_incident_resolution();
