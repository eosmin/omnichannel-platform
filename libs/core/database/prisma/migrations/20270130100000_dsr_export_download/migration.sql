-- The public download of the file of an access or portability request (Step 7.2-H2b-3). The person has no account and no store header: the link of
-- the closing mail carries a token of 256 bits whose SHA-256 hash is in `verification_tokens` (type `dsr_export_download`, subject = the request).
-- This lookup turns that hash into the request, the way `resolve_dsr_verification` does for the verification mail, and returns the ids of the
-- context and nothing else. A token is found only while it is unused and not expired, and only for a request that is an access or a portability,
-- is completed and still holds its file (`result_key`) before the date the file is kept until.
CREATE FUNCTION resolve_dsr_export_download(p_token_hash text)
  RETURNS TABLE (id text, store_id text, organization_id text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT r.id, r.store_id, r.organization_id
    FROM verification_tokens t
    JOIN data_subject_requests r ON r.id = t.subject
    WHERE t.token_hash = p_token_hash
      AND t.type = 'dsr_export_download'
      AND t.used_at IS NULL
      AND t.expires_at > now()
      AND r.type IN ('access', 'portability')
      AND r.status = 'completed'
      AND r.result_key IS NOT NULL
      AND r.result_expires_at > now()
      AND r.store_id IS NOT NULL
    LIMIT 1
  $$;

REVOKE ALL ON FUNCTION resolve_dsr_export_download(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_dsr_export_download(text) TO platform_app, platform_worker;
