-- D2c: an open contingency asks the authority every few minutes whether it answers again, and tells the person when it has lasted longer than the
-- authority allows without a technical report. Three columns of `fiscal_contingencies` (the table keeps its row security and its guard):
--  * `restored_at`: the first instant the probe found the authority answering while the contingency was still open. An upper bound of the real
--    end of the situation (the service may have come back earlier). From here no new document is kept in the contingency, and the person who
--    ends it by hand is offered this time as the end;
--  * `probe_halted_at`: the authority refused the credentials of the issuer: no probe asks again until the issuer is changed (three wrong
--    logins lock the user of the authority);
--  * `technical_report_warned_at`: the person was told the contingency needs a technical report ahead of its event.
ALTER TABLE "fiscal_contingencies" ADD COLUMN "restored_at" TIMESTAMP(3);
ALTER TABLE "fiscal_contingencies" ADD COLUMN "probe_halted_at" TIMESTAMP(3);
ALTER TABLE "fiscal_contingencies" ADD COLUMN "technical_report_warned_at" TIMESTAMP(3);
