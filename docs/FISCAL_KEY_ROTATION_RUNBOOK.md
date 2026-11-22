# Runbook: rotating `CREDENTIALS_ENCRYPTION_KEY` for the fiscal values (owner only)

This is run by the OWNER. No session, no CI job and no file of the repository ever holds a key: the repository is public. The owner
generates the new key, keeps the old one until the check at the end passes, and removes it afterwards. Design: Step 7.3-S11b-1 of
`IMPLEMENTATION_PLAN.md`; the cipher is `libs/core/crypto` (`CredentialCipher.openRotating`), the job is `FiscalResealService`.

## What the re-seal covers, and what it does NOT

Covered (the fiscal area): the receiver and the built payload of the fiscal documents (live, accepted and voided), the fiscal data of the
customers, the credentials of the fiscal issuer and the responsible of a contingency.

**NOT covered (Step 7.3-S11c, closes BEFORE the first rotation of the key in production):** every other sealed value of the platform (the
credentials of the channels and the carriers, the secrets of the webhooks, the sessions of OAuth, the plugin secrets, the address a closing
mail goes to). The previous key does not open them and no job seals them again. **Do not rotate `CREDENTIALS_ENCRYPTION_KEY` in an
environment that holds those values until S11c is merged**, or they become unreadable (a channel flips to `error`, a webhook stops
signing). The fiscal values can be rotated on their own only in an environment that has none of those.

## What the owner provides

- The NEW key: `openssl rand -hex 32` (64 hex characters). It goes to the secret store of the deployment, never to a chat, a ticket or a file
  of the repository.
- The OLD key, kept where it already is until step 6.

## Steps (each has a check; do not go on until it passes)

1. **Back up.** A backup of the database, restored once somewhere else. The re-seal never deletes a value, but the backup is the way back.
2. **Set both keys on the api AND the worker, together.** `CREDENTIALS_ENCRYPTION_KEY` = the new key and
   `CREDENTIALS_ENCRYPTION_KEY_PREVIOUS` = the old key. Restart both. Check: the processes start (they refuse to start when the previous key
   equals the current one, is the placeholder, or is not 64 hex characters). While both are set, the fiscal values open with either key and
   everything that is written is sealed with the new one.
3. **Wait for the nightly run** of the books (04:30 UTC, `RECONCILE_FINANCE`: the check of each organization runs the re-seal).
   Check in the worker log: `the fiscal values were checked for the previous key` per organization, with `resealed`, `failed` and `truncated`.
4. **Read the failures.** A job that fails with `sealed fiscal values were not sealed again` names its cause by code in the log
   (`a sealed fiscal value was not sealed again`, with `failure`, `what` and the ids of the row, never a value):
   - `key_mismatch`: opens with neither key. A wrong previous key, or a row that was altered. The row is LEFT AS IT WAS (nothing is lost).
     Do not remove the previous key. Find the row by its id and restore it from the backup if it is damaged.
   - `row_damaged`: the bytes are not a sealed value. Same: left as it was.
   - `key_missing`: the key of the process is not 32 bytes.
   - `reseal_mismatch`: the value opened but the one sealed again did not open to the same content; nothing was written. A defect of
     the job, not of the data: do not retire the previous key, report it.
   - `write_failed`: the value opened but the database refused the write (the log has the error name): not a damaged row. Look at the
     database, not at the backup.
5. **Check the end.** Two runs in a row (two nights) where every organization logs `resealed: 0`, `failed: {}` and `truncated: false`. `resealed: 0` means
   every value already opens with the new key. Also look at the audit trail: `fiscal.value_resealed` has one entry per value sealed again
   (kind and row id, never content).
   **Condition, a risk of LOSING DATA:** every organization that holds fiscal rows must appear in the log of the run. An organization
   with no books set up is not checked, and its fiscal data is NOT sealed again; retiring the previous key would make it unreadable. Ask
   for the IDs (never a count: a count cannot tell a missing organization from an extra one) of every organization with a fiscal value in
   any of the four tables, and take away the organizations that appear in the log of the last run:
   ```sql
   SELECT organization_id FROM fiscal_documents
   UNION SELECT organization_id FROM fiscal_issuers
   UNION SELECT organization_id FROM fiscal_contingencies
   UNION SELECT s.organization_id FROM customer_fiscal_data c JOIN stores s ON s.id = c.store_id;
   ```
   Run it **as the owner role (the one of the migrations)**: the four tables have row-level security, and with the role of the api and no
   context the query returns 0 rows, which reads as "all well". Compare the list with the organization ids of the log (`EXCEPT`, or a diff
   of the two lists). **The difference must be an EMPTY LIST**; any organization left over blocks step 6.
6. **Retire the old key.** Remove `CREDENTIALS_ENCRYPTION_KEY_PREVIOUS` from the api and the worker and restart. Check: the fiscal screens
   still open a document, a receiver and the issuer's credentials. Only now destroy the old key. Keep the backup of step 1 until then.

## Way back

Before step 6: put the old key back as `CREDENTIALS_ENCRYPTION_KEY` and the new one as `CREDENTIALS_ENCRYPTION_KEY_PREVIOUS` (the values
sealed again open with the previous key, the rest with the current one). After step 6 with the old key destroyed there is no way back
except the backup.

## Limits to know

- The owner of the function `fiscal_reseal_document` (the role of the migrations) also passes the door if it sets the setting by hand: the
  same level of power as being able to disable the trigger. The door is closed to `platform_app` and `platform_worker`.

- An organization is checked only by the nightly run of the books: an organization with no books set up has no night. Its fiscal data is
  not reached until it has them (debt in the plan, Step 7.3-S11b).
- The run seals again at most `FiscalReseal.MAX_VALUES_PER_KIND` values of each kind per organization and night (the values already
  current are only skipped and do not count): a larger organization takes more than one night, and `truncated: true` says the run stopped
  at the cap. Never retire the previous key while `truncated` is true.
- The guard of a decided fiscal document (and of a reported contingency) is not relaxed for anything but this job: only the functions
  `fiscal_reseal_document` and `fiscal_reseal_contingency` (the worker role alone) can swap the two sealed columns, and only for the same content (the job checks that the new value opens to the same text before it
  writes).
- The same nightly run also calculates the masked receiver of the documents that have none yet (`masked` in the report) with the CURRENT
  key alone, never the previous one, and through the function `fiscal_mask_document` (the third function the guard admits, worker only).
  A document whose receiver opens with neither key keeps no mask and is counted in `failed`; it is not an extra step of the rotation, and
  the screens open that row as before. The three columns it writes are in the clear by design: a letter and fill for the name, fill and
  four digits for the tax id (and only when it has nine or more digits).
