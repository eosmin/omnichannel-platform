-- The exports center draws a progress bar for a file being written: the worker counts what it will
-- write and keeps the percent here, 0 to 100. Null for a row that was never counted (and every row
-- that settled before this column existed).
ALTER TABLE "exports" ADD COLUMN "progress" INTEGER;
