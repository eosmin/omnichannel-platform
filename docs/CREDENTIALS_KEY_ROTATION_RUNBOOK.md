# Runbook: rotating `CREDENTIALS_ENCRYPTION_KEY` (owner only)

This is run by the OWNER. No session, no CI job and no file of the repository ever holds a key: the repository is public. The owner
generates the new key, keeps the old one until the check at the end passes, and removes it afterwards. Design: Step 7.3-S11b-1 of
`IMPLEMENTATION_PLAN.md` (Step 7.3-S11b for the fiscal values, Step 7.3-S11c for everything else); the cipher is `libs/core/crypto` (`CredentialCipher.openRotating`), the jobs are `FiscalResealService` and `CredentialsResealService`.

## What the re-seal covers

Two jobs, both run only while `CREDENTIALS_ENCRYPTION_KEY_PREVIOUS` is set (without it they read nothing and queue nothing). Every sealed
column of the schema is in one of the two, or is declared in `sealed-columns.spec.ts` as holding nothing sealed (that spec fails when a new
`Bytes` column is added without a decision).

**Fiscal re-seal** (`FiscalResealService`, inside the nightly books job `RECONCILE_FINANCE`, 04:30 UTC, only organizations with books set up):

| Column | Re-sealed |
| --- | --- |
| `fiscal_documents.receiver_encrypted`, `built_payload_encrypted` | yes (live, accepted and voided, through the function the guard recognises) |
| `fiscal_documents.void_event_encrypted` (the signed event of an invalidation) | yes (voided documents only, through `fiscal_reseal_void_event`) |
| `excluded_subject_purchases.seller_encrypted` (the document number and the name of the seller of a purchase from an excluded subject) | yes (through `fiscal_reseal_excluded_subject`) |
| `customer_fiscal_data.data_encrypted` | yes |
| `fiscal_issuers.credentials_encrypted` | yes |
| `fiscal_contingencies.responsible_encrypted` | yes |

**Credentials re-seal** (`CredentialsResealService`, Step 7.3-S11c; its own job `RESEAL_CREDENTIALS`, 04:45 UTC daily, **one job for EVERY
organization, with books or without them**):

| Column (sealed column = target id in the log) | Re-sealed |
| --- | --- |
| `channel_connections.credentials` (`connection-credentials`) | yes |
| `carrier_connections.credentials` (`carrier-credentials`), `carrier_connections.webhook_secret` (`carrier-webhook-secret`) | yes |
| `webhooks.secret` (`webhook-secret`) | yes |
| `plugin_installations.webhook_secret`, `command_secret`, `command_secret_previous` (`plugin-webhook-secret`, `plugin-command-secret`, `plugin-command-secret-previous`) | yes |
| `invitations.email_outbox` (`invitation-outbox`; bound to its invitation and store) | yes (it lives hours; if it was left sealed with the old key the invitation shows as not sent) |
| `data_subject_requests.notify_to_encrypted` (`dsr-notify-address`; text, not JSON) | yes |
| `data_subject_requests.result_password_sealed` (`dsr-export-password`; text, bound to its request) | yes (the password of the encrypted ZIP of a data export; it lives as long as the file, `DSR_EXPORT_LINK_DAYS` days. A password that opens with neither key leaves the download refused with the uniform answer and the export has to be made again) |

While both keys are set every reader of these values opens with either key (`openRotating`), so nothing stops working during the window, and
everything that is written is sealed with the new key.

**Short-lived values that are NOT re-sealed, on purpose (they expire; nothing is lost):**

| Value | Where | Longest life | What the user sees if the key is rotated while it exists |
| --- | --- | --- | --- |
| Session of a channel login (the user token of the OAuth flow) | Redis, `ChannelOAuthLimits.SESSION_TTL_SECONDS` | 15 minutes | Nothing while both keys are set (it opens with the previous one). After the previous key is retired a session older than the rotation cannot exist (15 minutes): the person starts the connection again |
| Mail job of a data request (sealed by `sealMailJob`) | Redis, queue `email` | Until sent or given up (about 32 minutes of retries) | Nothing while both keys are set (it opens with the previous one). A job older than the rotation, after the previous key is retired, is refused with fixed text and its request is marked `mail_failed`: the reviewer reaches the person |
| OAuth `state` | Redis, `STATE_TTL_SECONDS` | 10 minutes | It holds no sealed value |
| The payload of a public data request intake (the job in the queue) | BullMQ job, removed when processed | minutes | Opens with either key while both are set; a job that cannot open is dropped without a retry (as for any damaged job) and the person asks again |

**Values derived from the key.** None. `CREDENTIALS_ENCRYPTION_KEY` is used only to seal and open (AES-256-GCM); it feeds no hash, no HMAC
signature, no blind index and no fingerprint. The hash keys are their own: the keys of the data subject request hashes derive from
`JWT_SECRET`, `CONSENT_HASH_KEY` and `UNSUBSCRIBE_TOKEN_KEY` (the signature of the unsubscribe link) are their own, tokens are plain SHA-256 of a random value. A rotation of `CREDENTIALS_ENCRYPTION_KEY` therefore
invalidates nothing derived. (Rotating `JWT_SECRET`, `CONSENT_HASH_KEY` or `UNSUBSCRIBE_TOKEN_KEY` is another procedure, not covered here. To rotate `UNSUBSCRIBE_TOKEN_KEY` once unsubscribe links are being sent: set the NEW value in `UNSUBSCRIBE_TOKEN_KEY` and move the OLD value to `UNSUBSCRIBE_TOKEN_KEY_PREVIOUS` in the same deploy of the api and the worker. The previous key only VERIFIES (links already in a mailbox keep working) and never signs; new emails carry links under the new key. Remove `UNSUBSCRIBE_TOKEN_KEY_PREVIOUS` when the old links are no longer worth keeping (the links do not expire, so that is the owner's call). Where `UNSUBSCRIBE_TOKEN_KEY` is not set (a laptop, a test run) the signing key is derived from `JWT_SECRET`, so rotating `JWT_SECRET` ends every link already sent and cannot be covered by the previous key: a deployed environment always sets its own key, which is why it is required there. The env refuses a previous key equal to the current one or to another secret of the platform, and never prints the value; see part 2 of B6b-3b2b in `IMPLEMENTATION_PLAN.md`, Step 3.5 review debts.)

**Never sealed with this key:** the secrets that the plugins hold and the carriers hold on their side; the keys of the fiscal provider
kept in the environment.

## What the owner provides

- The NEW key: `openssl rand -hex 32` (64 hex characters). It goes to the secret store of the deployment, never to a chat, a ticket or a file
  of the repository.
- The OLD key, kept where it already is until step 6.

## Steps (each has a check; do not go on until it passes)

1. **Back up.** A backup of the database, restored once somewhere else. **Rehearse the whole rotation (steps 2 to 5) on that restored copy first**, with its own api and worker, before doing it in production. The re-seal never deletes a value, but the backup is the way back.
2. **Set both keys on the api AND the worker, together.** `CREDENTIALS_ENCRYPTION_KEY` = the new key and
   `CREDENTIALS_ENCRYPTION_KEY_PREVIOUS` = the old key. Restart both. Check: the processes start (they refuse to start when the previous key
   equals the current one, is the placeholder, or is not 64 hex characters). While both are set, the fiscal values open with either key and
   everything that is written is sealed with the new one.
3. **Keep the logs.** Keep the worker logs (level info) of both jobs, by organization, until step 6 is done: they are the evidence of the
   comparison of ids in step 5. Do not let them rotate away before that.
3b. **Wait for the nightly runs:** the fiscal one (04:30 UTC, `RECONCILE_FINANCE`, organizations with books) and the credentials one (04:45 UTC,
   `RESEAL_CREDENTIALS`, every organization). Check in the worker log, per organization, with `resealed`, `failed` and `truncated`:
   `the fiscal values were checked for the previous key` and `the sealed credentials were checked for the previous key`.
4. **Read the failures.** A job that fails with `sealed fiscal values were not sealed again` or `sealed values were not sealed again` names its cause by code in the log
   (`a sealed fiscal value was not sealed again` or `a sealed value was not sealed again`, with `failure`, `what` and the ids of the row, never a value):
   - Both jobs log the same codes; the credentials job names the column in `what` (a target id from the table above).
   - `key_mismatch`: opens with neither key. A wrong previous key, or a row that was altered. The row is LEFT AS IT WAS (nothing is lost).
     Do not remove the previous key. Find the row by its id and restore it from the backup if it is damaged.
   - `row_damaged`: the bytes are not a sealed value. Same: left as it was.
   - `key_missing`: the key of the process is not 32 bytes.
   - `reseal_mismatch`: the value opened but the one sealed again did not open to the same content; nothing was written. A defect of
     the job, not of the data: do not retire the previous key, report it.
   - `write_failed`: the value opened but the database refused the write (the log has the error name): not a damaged row. Look at the
     database, not at the backup.
5. **Check the end.** Two runs in a row (two nights) of EACH job where every organization logs `resealed: 0`, `conflicts: 0`, `failed: {}` and `truncated: false`.
   A `conflict` means a person changed the row while the job ran: the row was left alone and is picked up the next night, so keep waiting.
   **`truncated: true` means the run stopped at a cap with rows left: the previous key is NOT retired** (it is only in the info log, the job does not
   fail for it).
   `resealed: 0` means every value already opens with the new key. Also look at the audit trail: `fiscal.value_resealed` and
   `credentials.value_resealed` have one entry per value sealed again (kind or column, and row id, never content).
   **Condition, a risk of LOSING DATA:** every organization that holds a sealed value must appear in the log of the last run of the job that
   covers it. Ask for the IDs (never a count: a count cannot tell a missing organization from an extra one) and take away the organizations
   that appear in the log. **The difference must be an EMPTY LIST**; any organization left over blocks step 6.
   - Credentials job: it queues EVERY organization, so the list to compare is simply all of them:
     ```sql
     SELECT id FROM organizations;
     ```
     (and the log of `RESEAL_CREDENTIALS` of the last night must name each id).
   - Fiscal job: only organizations with books set up are visited, so list the ones that hold a fiscal value, books or not:
     ```sql
     SELECT organization_id FROM fiscal_documents
     UNION SELECT organization_id FROM fiscal_issuers
     UNION SELECT organization_id FROM fiscal_contingencies
     UNION SELECT s.organization_id FROM customer_fiscal_data c JOIN stores s ON s.id = c.store_id;
     ```
   Run them **as the owner role (the one of the migrations)**: the tables have row-level security, and with the role of the api and no
   context the query returns 0 rows, which reads as "all well". Compare each list with the organization ids of the log (`EXCEPT`, or a diff
   of the two lists).
   Finally, prove that nothing is left sealed with the old key, as the owner, with the previous key still set: the log of both jobs of the
   last night says `resealed: 0`, and `current` equals the number of values (`scanned`).
6. **Retire the old key.** Remove `CREDENTIALS_ENCRYPTION_KEY_PREVIOUS` from the api and the worker and restart. Check: the fiscal screens
   still open a document, a receiver and the issuer's credentials, and a channel, a carrier connection, a webhook delivery (test event) and a
   plugin command still work. Only now destroy the old key. Keep the backup of step 1 until then.

## Way back

**Read this before swapping:** once the old key is current and the new one is previous, both jobs are enabled again and, the next night, seal
every value back with the old key. Decide the way back, then remove `CREDENTIALS_ENCRYPTION_KEY_PREVIOUS` (or wait for the jobs to finish) and
restart step 5 from the beginning with whichever key you keep.

Before step 6: put the old key back as `CREDENTIALS_ENCRYPTION_KEY` and the new one as `CREDENTIALS_ENCRYPTION_KEY_PREVIOUS` (the values
sealed again open with the previous key, the rest with the current one). After step 6 with the old key destroyed there is no way back
except the backup.

## Limits to know

- The owner of the function `fiscal_reseal_document` (the role of the migrations) also passes the door if it sets the setting by hand: the
  same level of power as being able to disable the trigger. The door is closed to `platform_app` and `platform_worker`.

- The fiscal values of an organization with no books set up are NOT reached by the fiscal job (it rides on the books). Today an organization
  without books holds no fiscal value, since a document needs them; the query in step 5 lists the organizations that do hold one, so a
  difference blocks step 6 (debt in the plan: close it with a fiscal sweep over every organization, Step 7.3).
- The credentials job seals again at most `CredentialsReseal.MAX_VALUES_PER_TARGET` values of each column per organization and night, the fiscal
  one at most `FiscalReseal.MAX_VALUES_PER_KIND` values of each kind (the values already
  current are only skipped and do not count): a larger organization takes more than one night, and `truncated: true` says the run stopped
  at the cap. Never retire the previous key while `truncated` is true.
- The guard of a decided fiscal document (and of a reported contingency) is not relaxed for anything but this job: only the functions
  `fiscal_reseal_document`, `fiscal_reseal_void_event`, `fiscal_reseal_excluded_subject` and `fiscal_reseal_contingency` (the worker role alone) can swap the sealed columns, and only for the same content (the job checks that the new value opens to the same text before it
  writes).
- The credentials job writes through plain updates guarded by the old bytes (compare-and-swap) and the context of the organization: the
  tables it touches have no guard like the fiscal one, so it needs no function of the migrator and opens no door. A row changed by a person
  during the run is a `conflict` (counted, left alone, picked up the next night). It does bump `updated_at` of the row it seals again.
- A value that was never sealed with the platform key (a test row, a value written by hand) is `row_damaged` or `key_mismatch`: it is left as
  it is and blocks step 6 until somebody decides about it.
- The same nightly run also calculates the masked receiver of the documents that have none yet (`masked` in the report) with the CURRENT
  key alone, never the previous one, and through the function `fiscal_mask_document` (the third function the guard admits, worker only).
  A document whose receiver opens with neither key keeps no mask and is counted in `failed`; it is not an extra step of the rotation, and
  the screens open that row as before. The three columns it writes are in the clear by design: a letter and fill for the name, fill and
  four digits for the tax id (and only when it has nine or more digits).
