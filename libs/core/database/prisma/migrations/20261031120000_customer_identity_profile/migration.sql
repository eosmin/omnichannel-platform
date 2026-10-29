-- The name, username and photo link that Instagram and Messenger keep for a customer, and when and how
-- the last read of them ended (the display name already has its column).
ALTER TABLE "customer_identities"
  ADD COLUMN "username" TEXT,
  ADD COLUMN "avatar_url" TEXT,
  ADD COLUMN "profile_fetched_at" TIMESTAMP(3),
  ADD COLUMN "profile_fetch_error" TEXT;
