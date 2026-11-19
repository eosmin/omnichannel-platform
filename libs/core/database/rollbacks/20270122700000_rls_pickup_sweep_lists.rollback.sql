-- Rollback of 20270122700000_rls_pickup_sweep_lists: the code that calls these functions (PickupEvaluator.sweep) goes first (revert the
-- commit), then this runs. Idempotent.
DROP FUNCTION IF EXISTS public.rls_list_pickups_count_behind(text[], date, timestamp, integer);
DROP FUNCTION IF EXISTS public.rls_list_pickups_pending_stale(text, timestamp, date, integer);
