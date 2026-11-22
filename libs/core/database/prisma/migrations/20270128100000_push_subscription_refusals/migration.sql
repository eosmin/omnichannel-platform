-- Counts the pushes in a row that the push service refused for good, so a browser that never takes a push is dropped
-- instead of staying in the list for ever. The default makes every existing row start at zero.
ALTER TABLE "push_subscriptions" ADD COLUMN "refused_count" INTEGER NOT NULL DEFAULT 0;
