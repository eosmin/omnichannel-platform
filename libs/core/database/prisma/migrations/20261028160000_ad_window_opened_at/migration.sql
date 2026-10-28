-- The first message after a click on an ad: Instagram and Messenger let the store answer up to 7 days
-- from it (Meta, changelog of 2026-09-28), and the window is counted from this date.
ALTER TABLE "customer_identities" ADD COLUMN "ad_window_opened_at" TIMESTAMP(3);
