-- Rollback of 20270123000000_rls_transfer_line_store_ids: the code that calls this function (TransfersService, the write routes of a
-- plugin) goes first (revert the commit), then this runs. Idempotent.
DROP FUNCTION IF EXISTS public.rls_transfer_line_store_ids(text);
