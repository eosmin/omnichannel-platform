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
   Check in the worker log: `the fiscal values were checked for the previous key` per organization, with `resealed` and `failed`.
4. **Read the failures.** A job that fails with `sealed fiscal values were not sealed again` names its cause by code in the log
   (`a sealed fiscal value was not sealed again`, with `failure`, `what` and the ids of the row, never a value):
   - `key_mismatch`: opens with neither key. A wrong previous key, or a row that was altered. The row is LEFT AS IT WAS (nothing is lost).
     Do not remove the previous key. Find the row by its id and restore it from the backup if it is damaged.
   - `row_damaged`: the bytes are not a sealed value. Same: left as it was.
   - `key_missing`: the key of the process is not 32 bytes.
5. **Check the end.** Two runs in a row (two nights) where every organization logs `resealed: 0` and `failed: {}`. `resealed: 0` means
   every value already opens with the new key. Also look at the audit trail: `fiscal.value_resealed` has one entry per value sealed again
   (kind and row id, never content).
6. **Retire the old key.** Remove `CREDENTIALS_ENCRYPTION_KEY_PREVIOUS` from the api and the worker and restart. Check: the fiscal screens
   still open a document, a receiver and the issuer's credentials. Only now destroy the old key. Keep the backup of step 1 until then.

## Way back

Before step 6: put the old key back as `CREDENTIALS_ENCRYPTION_KEY` and the new one as `CREDENTIALS_ENCRYPTION_KEY_PREVIOUS` (the values
sealed again open with the previous key, the rest with the current one). After step 6 with the old key destroyed there is no way back
except the backup.

## Limits to know

- An organization is checked only by the nightly run of the books: an organization with no books set up has no night. Its fiscal data is
  not reached until it has them (debt in the plan, Step 7.3-S11b).
- The run touches at most `FiscalReseal.MAX_PAGES_PER_KIND` pages of each kind per organization and night; a larger organization takes
  more than one night, and `resealed` tells when it is done.
- The guard of a decided fiscal document is not relaxed for anything but this job: only the function `fiscal_reseal_document` (the worker role
  alone) can swap the two sealed columns, and only for the same content (the job checks that the new value opens to the same text before it
  writes).
