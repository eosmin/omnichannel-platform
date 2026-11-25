-- D2c: an open contingency asks the authority every few minutes whether it answers again, and tells the person when it has lasted longer than the
-- authority allows without a technical report. Three columns of `fiscal_contingencies` (the table keeps its row security and its guard):
--  * `restored_at`: the first instant the probe found the authority answering while the contingency was still open. An upper bound of the real
--    end of the situation (the service may have come back earlier). From here no new document is kept in the contingency, and the person who
--    ends it by hand is offered this time as the end;
--  * `probe_halted_fingerprint`: the authority refused the credentials of the issuer: a fingerprint of the sealed credentials it refused. No probe
--    asks again while the issuer holds the same ones (three wrong logins lock the user of the authority). The issuer row itself is not a signal:
--    it changes with every document (the correlative);
--  * `technical_report_warned_at`: the person was told the contingency needs a technical report ahead of its event.
ALTER TABLE "fiscal_contingencies" ADD COLUMN "restored_at" TIMESTAMP(3);
ALTER TABLE "fiscal_contingencies" ADD COLUMN "probe_halted_fingerprint" TEXT;
ALTER TABLE "fiscal_contingencies" ADD COLUMN "technical_report_warned_at" TIMESTAMP(3);
