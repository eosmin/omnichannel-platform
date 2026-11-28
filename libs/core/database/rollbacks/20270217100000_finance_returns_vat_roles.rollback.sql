-- Rolls back 20270217100000_finance_returns_vat_roles: removes ONLY the accounts and mappings that migration wrote (found by their id, a
-- deterministic uuid of the organization and the code), and only those with no entries and no other reference. An account that already holds
-- entries, or that something points at (a payment method, a tax rate, a child account), is KEPT with its mapping and reported with a NOTICE:
-- this script never deletes a line of the books. Accounts the setup seeded for an organization created after the migration are not touched.
-- The CHECK of the roles is left WIDENED on purpose: narrowing it would have to delete the mappings of the new roles that setup wrote for newer
-- organizations, and an older release ignores a mapping it does not know. Idempotent: a second run finds nothing left to do.
BEGIN;

DO $$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT a.id, a.organization_id, a.code
    FROM ledger_accounts a
    WHERE a.code IN ('1402', '1405', '1406', '2103', '6113')
      AND a.id = md5(a.organization_id || ':finance_returns_vat:' || a.code)::uuid::text
  LOOP
    IF EXISTS (SELECT 1 FROM journal_lines l WHERE l.organization_id = rec.organization_id AND l.account_id = rec.id) THEN
      RAISE NOTICE 'kept: account % of organization % has entries', rec.code, rec.organization_id;
      CONTINUE;
    END IF;
    BEGIN
      -- Only the five roles of this migration: another role that someone pointed at this account is not ours to take away (the account is
      -- then kept by the foreign key and reported)
      DELETE FROM account_role_mappings
      WHERE organization_id = rec.organization_id AND account_id = rec.id
        AND role IN ('vat_pending_document', 'accrued_commissions_undocumented', 'income_tax_prepayment', 'vat_card_advance', 'vat_non_recoverable');
      DELETE FROM ledger_accounts WHERE organization_id = rec.organization_id AND id = rec.id;
    EXCEPTION WHEN foreign_key_violation OR restrict_violation OR raise_exception THEN
      -- The block undoes both deletes: the account stays mapped. The reason is printed, so a guard that refused for another cause is seen
      RAISE NOTICE 'kept: account % of organization % could not be deleted (%)', rec.code, rec.organization_id, SQLERRM;
    END;
  END LOOP;
END $$;

COMMIT;
