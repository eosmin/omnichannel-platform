-- Rollback of 20270122800000_rls_remote_channel_plugins: the code that calls this function (RemoteChannelSync.readAll through
-- WorkerLists.remoteChannelPlugins) goes first (revert the commit), then this runs. Idempotent.
DROP FUNCTION IF EXISTS public.rls_list_remote_channel_plugins(text, text, text, text, integer);
