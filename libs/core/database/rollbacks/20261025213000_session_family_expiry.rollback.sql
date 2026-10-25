-- Rolls back 20261025213000_session_family_expiry.
ALTER TABLE IF EXISTS sessions DROP COLUMN IF EXISTS family_expires_at;
