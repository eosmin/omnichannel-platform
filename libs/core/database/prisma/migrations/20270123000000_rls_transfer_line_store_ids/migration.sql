-- Row-Level Security, phase 6: the write routes of a PLUGIN decide "the transfer holds only lines of the store of my key" (every line of
-- it is of that store, or the write is refused). The key of a plugin is bound to ONE store, so the context of its request holds that store
-- alone, and stock_transfer_lines is a `store` table: the lines of a sibling store of the organization are invisible to it, the decision
-- was taken on what was left, and a dispatch went through for the store of the key and skipped the units of the sibling (partial, silent).
-- The context of a plugin is NOT widened (a widening would give a bug of the service access to the rows of a sibling store under the
-- identity of a plugin). This function answers ONE question, with ids alone: which stores do the lines of this transfer belong to. It is
-- used only to REFUSE, never to read a row: it returns store ids, no quantity, no product, no note.
--
-- Contract: the transfer must be of an organization of the context (app.organization_ids, read ONCE); a transfer of another organization
-- and one that does not exist answer the same, NULL (the service turns it into the same 404, so there is no oracle between "does not
-- exist" and "is of another organization"); a transfer with no line answers an empty list. There is no organization parameter: the
-- organization comes from the context the guards resolved, never from the caller. A call with no organization in the context is an
-- error (22023), never an answer. It reads only (STABLE), the search_path is fixed with pg_temp last and every object is qualified.
-- Granted to platform_app alone: the worker has no use for it and the read-only role never calls it. No policy is created or changed
-- here, so rls_extend_policies_to_replica() has nothing to extend.

CREATE FUNCTION public.rls_transfer_line_store_ids(p_transfer_id text)
  RETURNS text[]
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    v_organizations text[] := public.app_organization_ids();
    v_stores text[];
  BEGIN
    IF cardinality(v_organizations) = 0 THEN
      RAISE EXCEPTION 'the stores of the lines of a transfer need an organization in the context' USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.stock_transfers t
      WHERE t.id = p_transfer_id AND t.organization_id = ANY (v_organizations)
    ) THEN
      RETURN NULL;
    END IF;
    SELECT COALESCE(array_agg(DISTINCT l.store_id ORDER BY l.store_id), ARRAY[]::text[]) INTO v_stores
    FROM public.stock_transfer_lines l
    WHERE l.transfer_id = p_transfer_id;
    RETURN v_stores;
  END
  $$;

REVOKE ALL ON FUNCTION public.rls_transfer_line_store_ids(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rls_transfer_line_store_ids(text) TO platform_app;
