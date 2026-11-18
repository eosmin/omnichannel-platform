-- Rolls back 20270120090000_finance_register_needs_view_journal. The migration only granted a read permission, and the rows it added
-- cannot be told from the ones an administrator gave, so nothing is removed: taking finance:view_journal from a role could lock a
-- bookkeeper out of what they registered. Revert the code (PermissionRequires) to stop enforcing the pair. Safe to run twice.
BEGIN;
COMMIT;
