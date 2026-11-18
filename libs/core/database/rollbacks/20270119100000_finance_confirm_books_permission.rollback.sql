-- Rolls back 20270119100000_finance_confirm_books_permission: nobody holds the permission any more. The layouts already confirmed stay
-- confirmed (their rows are not touched). Safe to run twice.
BEGIN;
DELETE FROM "permissions" WHERE "name" = 'finance:confirm_books';
COMMIT;
