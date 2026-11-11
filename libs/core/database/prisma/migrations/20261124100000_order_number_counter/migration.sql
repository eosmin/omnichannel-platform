-- Step 4.3 (PR B): the counter of the order numbers of a store. Additive.
--  * next_order_number: the number the next order of the store takes. OrdersService reads and raises it in the same
--    statement (UPDATE ... RETURNING) inside the transaction that creates the order, so two orders never share a number
--    and a rolled-back order gives its number back. Counting orders or reading the largest number would scan the table.
--
-- A store that already has orders (tests, development) would start at 1 and could take a number that is in use: the
-- counter starts above the largest number made only of digits (up to ten, capped at the largest Int), so the first order
-- after this migration never collides. Numbers that are not digits ('ORD-1001' of an older fixture) are not counted:
-- they cannot collide with ours.

-- AlterTable
ALTER TABLE "store_settings" ADD COLUMN "next_order_number" INTEGER NOT NULL DEFAULT 1;

UPDATE "store_settings" AS settings
SET "next_order_number" = counted.next
FROM (
  SELECT "store_id", LEAST(MAX("order_number"::bigint) + 1, 2147483647) AS next
  FROM "orders"
  WHERE "order_number" ~ '^[0-9]{1,10}$'
  GROUP BY "store_id"
) AS counted
WHERE settings."store_id" = counted."store_id";
