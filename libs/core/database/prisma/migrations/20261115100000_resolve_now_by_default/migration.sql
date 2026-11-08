-- Resolving is immediate by default now (owner, 2026-11-08): the button of a conversation resolves at once
-- and its arrow offers the dialog with the closing message and the reason. Only the DEFAULT of the column
-- changes, so it reaches the stores created from now on; every row that exists keeps the value it has,
-- the one of the owner included. No data is touched.
ALTER TABLE "store_settings" ALTER COLUMN "resolve_show_options" SET DEFAULT false;
