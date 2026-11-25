-- D14: a document the authority refused is corrected and sent again within 24 hours of the moment the refusal was communicated, with the same
-- generation code. The moment is kept with the document (`rejected_at`), and the moment the person was warned that the window is closing
-- (`rejection_warned_at`, once for each refusal). Both are cleared when the document is queued again. The table is already tenant-scoped
-- (organization_id, store_id) and under row-level security: a column adds no policy of its own. A decided (accepted, voided) document never
-- holds either: the guard compares the whole row of an accepted one, so nothing about it can change.
-- AlterTable
ALTER TABLE "fiscal_documents" ADD COLUMN "rejected_at" TIMESTAMP(3), ADD COLUMN "rejection_warned_at" TIMESTAMP(3);

-- A document that is refused now was refused by the authority when its submission moved (core's own refusals never move it): the moment of
-- its last change is the nearest date there is, so it has its window and is not left with none. One whose window is already over is marked
-- as warned, so the first daily check after the deploy does not tell the person of every old refusal at once.
UPDATE "fiscal_documents"
SET "rejected_at" = "updated_at",
    "rejection_warned_at" = CASE WHEN "updated_at" + interval '24 hours' < now() THEN "updated_at" END
WHERE "status" = 'rejected' AND "submission" > 1;
