-- A reply that failed for good can be thrown away by an agent (the web draws the button): `discarded_at` hides it
-- and `failure_definitive` records whether the failure means the provider did not take it.
-- AlterTable
ALTER TABLE "messages" ADD COLUMN "discarded_at" TIMESTAMP(3),
ADD COLUMN "failure_definitive" BOOLEAN;
