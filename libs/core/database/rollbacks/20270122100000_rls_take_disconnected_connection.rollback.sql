-- Rollback of 20270122100000_rls_take_disconnected_connection: the code that calls it (ChannelConnectionsService.connect) goes first
-- (revert the commit), then this runs. Idempotent. A row it already renamed ('~released~') stays as the code left it.
DROP FUNCTION IF EXISTS public.rls_take_disconnected_connection(text, text, text);
