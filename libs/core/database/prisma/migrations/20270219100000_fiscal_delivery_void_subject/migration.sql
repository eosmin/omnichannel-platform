-- D13b-2b-2 (B): the delivery of the event of an invalidation to the receiver (Normativa DTE v2.0, apartado 11, page 23). A document is owed two
-- deliveries now, each a row of this table: the files of the document, given when it is accepted (`subject` = 'document'), and the files of its
-- invalidation, given when it is voided (`subject` = 'void'). The unique key is the document AND the subject, so each is delivered once.
-- It also closes the debt of 20270205100000_fiscal_deliveries: a delivery is a record of what a receiver was given, and until now the roles of the
-- api and the worker could update and delete it. The guard below lets one thing change, a delivery that was not sent becoming a hand delivery.
-- The table is already tenant-scoped and under row-level security: a column adds no policy of its own.
-- Rollback: rollbacks/20270219100000_fiscal_delivery_void_subject.rollback.sql
ALTER TABLE "fiscal_deliveries" ADD COLUMN "subject" TEXT NOT NULL DEFAULT 'document';
ALTER TABLE "fiscal_deliveries" ADD CONSTRAINT "chk_fiscal_deliveries_subject" CHECK ("subject" IN ('document', 'void'));

DROP INDEX "fiscal_deliveries_document_id_key";
CREATE UNIQUE INDEX "fiscal_deliveries_document_id_subject_key" ON "fiscal_deliveries"("document_id", "subject");

-- The outcome: the form of 20270208100000 with the reason of an invalidation that has no event to give, and the hand delivery of its answer
ALTER TABLE "fiscal_deliveries" DROP CONSTRAINT "chk_fiscal_deliveries_outcome";
ALTER TABLE "fiscal_deliveries" ADD CONSTRAINT "chk_fiscal_deliveries_outcome" CHECK (
  (status = 'sent' AND route IN ('channel', 'email') AND reason IS NULL
      AND hand_means IS NULL AND handed_over_by IS NULL AND handed_over_at IS NULL)
  OR (status = 'sent' AND route = 'manual' AND hand_means IN ('download', 'paper', 'answer')
      AND handed_over_by IS NOT NULL AND handed_over_at IS NOT NULL
      AND (reason IS NULL OR reason IN ('no_channel', 'files_unavailable', 'too_large', 'customer_erased', 'void_event_unavailable')))
  OR (status = 'not_sent' AND route = 'none'
      AND reason IN ('no_channel', 'files_unavailable', 'too_large', 'customer_erased', 'void_event_unavailable')
      AND hand_means IS NULL AND handed_over_by IS NULL AND handed_over_at IS NULL)
);
-- The reason and the means that belong to an invalidation are only of an invalidation
ALTER TABLE "fiscal_deliveries" ADD CONSTRAINT "chk_fiscal_deliveries_void_only" CHECK (
  "subject" = 'void' OR (reason IS DISTINCT FROM 'void_event_unavailable' AND hand_means IS DISTINCT FROM 'answer')
);

-- The guard: a delivery is never deleted, and the only change it takes is a delivery that was not sent becoming a hand delivery (the status, the
-- route, the means and who and when), everything else of the row fixed, the subject included. The whole row is compared, so a column added later
-- is immutable until it is listed here.
CREATE FUNCTION fiscal_delivery_guard() RETURNS trigger
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a fiscal delivery is never deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'not_sent' AND NEW.status = 'sent' AND NEW.route = 'manual'
     AND NEW.handed_over_by IS NOT NULL AND NEW.handed_over_at IS NOT NULL AND NEW.hand_means IS NOT NULL
     AND (to_jsonb(NEW) - 'status' - 'route' - 'hand_means' - 'handed_over_by' - 'handed_over_at')
         IS NOT DISTINCT FROM (to_jsonb(OLD) - 'status' - 'route' - 'hand_means' - 'handed_over_by' - 'handed_over_at') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a fiscal delivery only changes from not sent to given by hand' USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_fiscal_delivery_guard BEFORE UPDATE OR DELETE ON "fiscal_deliveries"
  FOR EACH ROW EXECUTE FUNCTION fiscal_delivery_guard();

-- The worker only ever INSERTS a delivery (the automatic one, the daily check and the reconciler write nothing here: they publish the event), and a
-- hand delivery is a person's act of the api. Without UPDATE a worker cannot record one in anybody's name, whatever the guard lets through.
REVOKE UPDATE ON "fiscal_deliveries" FROM platform_worker;
