-- Rolls back 20261115100000_resolve_now_by_default: new stores are born asking for the options again. The
-- rows created while the default was false keep their value (it was never a choice that can be told apart
-- from a default). Run it after the code that reads the default is reverted.
BEGIN;

ALTER TABLE "store_settings" ALTER COLUMN "resolve_show_options" SET DEFAULT true;

COMMIT;
