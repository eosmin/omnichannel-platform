-- Step 7.2-H (B4, DSR-LOCALE): the language the person asked in. The closing mail of a request (rejected, completed, expired) went in the
-- default language of the store, so a person who asked in English got the notice in Spanish. The intake already knows the language (it
-- sends the verification mail in it); it is kept here, as a code of SUPPORTED_LOCALES, so every flow that ends the request writes to the person
-- in the language they used. NULL (a request made before this) keeps the store default. It names no one: the address stays sealed.
-- Rollback: rollbacks/20270129110000_dsr_notice_locale.rollback.sql
ALTER TABLE "data_subject_requests" ADD COLUMN "notice_locale" TEXT;
