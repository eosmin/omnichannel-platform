-- Rollback of 20270123100000_rls_plugin_foreign_owner: the code that calls this function (PluginRegistrationService.iconToFetch) goes
-- first (revert the commit), then this runs. Idempotent.
DROP FUNCTION IF EXISTS public.rls_plugin_foreign_owner(text);
