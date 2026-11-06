-- A consumed refresh token may come back once inside a short grace window (TDD_01 section 7); this is
-- the mark that the one time was used.
-- AlterTable
ALTER TABLE "sessions" ADD COLUMN "grace_used_at" TIMESTAMP(3);
