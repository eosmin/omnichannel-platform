# Runbook: protecting the production bucket (owner only)

This is run by the OWNER (or whoever holds the credential of the bucket), never by a session or by the CI. It applies, with
`pnpm storage:bucket-protection`, the decision of 2026-11-21 (`TDD_03_Deployment.md §7.3`): versioning ON on the production bucket,
a lifecycle rule that expires the old (noncurrent) versions after **30 days**, and one that aborts unfinished multipart uploads after
**7 days**. Both periods are editable (below). The api and the worker only WATCH this protection
(`StorageService.inspectProtection`, metric `platform_storage_bucket_protection_gap{protection}`); nothing else in the repository applies it,
and nothing in the repository creates the production bucket. Step 7.5 of `IMPLEMENTATION_PLAN.md` lists this as a gate before real customers.

Why it matters: the sweeps of the files stored before the metadata cleaning (`ExistingPictureSanitizer`, `ExistingDocumentSanitizer`,
`ExistingAvSanitizer`) re-encode each original in place, and versioning is their way back. `VersionedBucketGuard` keeps them stopped in `staging`
and `production` until the bucket answers that versioning is on. With versioning on, deleting the bytes of a customer only adds a delete
marker, so the bytes live as noncurrent versions until the 30-day rule expires them: a legal deletion is complete up to 30 days later (the
privacy text says "up to 30 days").

## What the command does

| Mode | Changes the bucket | What it does |
| --- | --- | --- |
| `status` (default) | no | Prints versioning, the encryption (reported only), our rule and the rules of somebody else. Exit 1 while the protection is incomplete, so it can gate a deploy. |
| `apply` | yes | Turns versioning on if it is not, reads the lifecycle rules that exist, replaces (or adds) only the rule `platform-bucket-protection`, keeps every other rule as it was, then reads the bucket again until it shows the result. |
| `revert` | yes | Removes only our rule (the whole configuration when ours was the only rule). Leaves versioning on unless `--suspend-versioning` is given. |

Safety, all enforced by the command and covered by `scripts/lib/bucket-protection.spec.ts`:

- `apply` and `revert` run only with `--confirm=<name of the bucket>` equal to `S3_BUCKET`; a different or missing name stops before the first request. **Type the name; never write `--confirm=$S3_BUCKET`**: the shell would expand it to the very variable the command checks, and a shell that still holds the variable of another bucket would pass.
- The bucket `platform-dev` (local development) and a local store (`localhost`, `127.x`, `0.0.0.0`, `::1`, `host.docker.internal`, a host with no dot such as `seaweedfs`, `*.local`; a store on a private network address is not recognised, so check that `status` prints the host you mean) are refused in every mode.
- `PutBucketLifecycleConfiguration` REPLACES all the rules of a bucket. The command reads them first and sends the merged set; if the rules cannot be read (access denied, a store that does not answer) it writes nothing. The old rule that TDD_03 pasted (`expire-noncurrent`) counts as ours and is replaced, not duplicated. The setting `TransitionDefaultMinimumObjectSize` of the configuration is sent back as it was read.
- Credentials come only from the environment of the shell. No `.env` file is read, nothing is printed or written, and the endpoint is shown as its host only (the host the client really uses, also when the SDK takes it from `AWS_ENDPOINT_URL*` or `~/.aws/config`).
- A rule with the legacy id `expire-noncurrent` is replaced only when it has the shape TDD_03 pasted; any other content under that id is somebody else's and is kept.
- Idempotent: a second `apply` sends no write. If it stops half way (versioning on, lifecycle failed), run it again.
- Before it writes the lifecycle it prints one line `rules before the change (keep this line)`: the previous rules as JSON, to put back by hand if needed.

## Prerequisites

1. **A bucket that exists** in the provider chosen for the deployment, in the region of the api and the worker. Creating it needs a real account, so it is the owner's step.
2. **A separate operator credential, not the one of the application.** Prefer temporary credentials (SSO or an assumed role; the command also reads `AWS_SESSION_TOKEN`). Minimum actions on the bucket ARN itself (`arn:aws:s3:::<bucket>`, bucket-level actions, not `<bucket>/*`):
   `s3:GetBucketVersioning`, `s3:PutBucketVersioning`, `s3:GetLifecycleConfiguration`, `s3:PutLifecycleConfiguration`, `s3:GetEncryptionConfiguration`. `revert` also needs `s3:PutLifecycleConfiguration` (it deletes the configuration through it on AWS S3). If MFA delete is on, S3 asks for an MFA code that this command does not send: turn it off by the provider's own tools first, or do the versioning step by hand.
3. **The application role** (api and worker) needs `s3:GetBucketVersioning` and `s3:GetEncryptionConfiguration` on the bucket ARN. Without them the check answers "unknown", which counts as a gap, and `VersionedBucketGuard` keeps the sweeps stopped.
4. **Encryption at rest** is checked, not applied, by this command (it only reports it). Set it with the provider (`TDD_03 §7.3`, `put-bucket-encryption`); the gap metric has a `protection="encryption"` series too.
5. **Replication** (if used) needs versioning on the source AND on the replica bucket, and the replica gets the same lifecycle rules: run this command once per bucket, with that bucket's name in `S3_BUCKET`.
6. **Provider compatibility.** The command uses five standard S3 calls: `GetBucketVersioning`, `PutBucketVersioning`, `GetBucketLifecycleConfiguration`, `PutBucketLifecycleConfiguration`, `DeleteBucketLifecycle` (plus `GetBucketEncryption` to report). AWS S3 is the reference. For any other S3-compatible provider (set `S3_ENDPOINT`, and `S3_FORCE_PATH_STYLE=true` if it needs path style) check its documentation for object versioning AND for noncurrent-version expiration, and rehearse on a throw-away bucket of that provider first: a provider that does not support versioning will answer an error or keep the state `Unversioned`, and the guard then keeps the sweeps stopped for good. Never rehearse on the production bucket.
7. A person watching. One operator at a time: S3 has no conditional write for the lifecycle, so two people running `apply` together could overwrite each other's rules.

## Steps

All commands run from the repository, with the credential exported in the shell (never in a file of the repository, never pasted in a chat or an issue; the repository is public):

```bash
export AWS_ACCESS_KEY_ID=...        # operator credential, from your own secret store
export AWS_SECRET_ACCESS_KEY=...
export AWS_SESSION_TOKEN=...        # only for temporary credentials
export AWS_REGION=<region of the bucket>
export S3_BUCKET=<name of the production bucket>
export S3_ENDPOINT=...              # only for a provider other than AWS S3
```

1. **Look first.** `pnpm storage:bucket-protection status`. Read the rules of somebody else it lists: they stay, but a rule of theirs that also expires old versions or unfinished uploads acts together with ours (S3 applies every rule; the shortest period wins).
2. **Apply.** `pnpm storage:bucket-protection apply --confirm=<name of the bucket, typed by hand>`. For other periods: `--noncurrent-days=<n> --abort-multipart-days=<n>` (1 to 3650). Save the line `rules before the change` somewhere private (its filters may name internal prefixes: never paste it in an issue or a chat). On a bucket whose versioning is already on or suspended the command also warns that the versions older than the period are deleted for good. Shortening the period of an existing rule deletes for good, at the next lifecycle run, the versions older than the new period; the command warns when you do.
3. **Check the bucket.** `pnpm storage:bucket-protection status` must say `versioning: Enabled`, our rule `present`, and `protection: complete`, exit code 0.
4. **Check the application.** The api and the worker ask again every hour (a restart asks at once). Then `platform_storage_bucket_protection_gap{protection="versioning"}` reads 0 and the warning about the protection disappears from the logs. Alert on any value above 0.

**Order inside `apply`: versioning first, the lifecycle rule second** (a few seconds apart, with the verification reads after). The worker checks the bucket at the start of each sweep run (every ten minutes), so a run that begins in those seconds can see versioning on before the 30-day rule exists. Nothing is lost by it (the rule expires versions by their age, so it also covers any version made in between), but the first rewritten originals would sit without a rule for those seconds. Run `apply` in a quiet window, with the worker stopped or between two sweep runs, and start the worker (or let it run) after `status` says `protection: complete`. The command sends every request with a 10 second connection and 30 second request timeout, so a store that does not answer fails the run instead of hanging it; run it again, it is idempotent.

**Apply is also what releases the sweeps.** As soon as the worker sees versioning on in production, the three sweeps start to rewrite the old files in place (each original stays as a noncurrent version for the period you set). Apply it when the worker you want is deployed, not before.

## Way back

- `pnpm storage:bucket-protection revert --confirm=<name of the bucket, typed by hand>` removes our rule only. The old versions then stay (cost, and deleted customer data kept) until another rule or a person removes them; the command says so.
- `revert --suspend-versioning` also suspends versioning (S3 cannot turn it fully off). The versions already stored stay, new writes stop making versions, and the sweeps stop again because the guard no longer sees versioning on. Do it only if the owner decides the bucket must not keep versions.
- To restore the previous rules exactly, put back the line `rules before the change` with the provider's own tool.

## What the owner decides

- The two periods (the decision of 2026-11-21 is 30 days and 7 days). A longer period is more storage and a longer wait before a deleted customer's bytes are really gone; a shorter one is less room to recover from a bad sweep.
- The provider and the region of the production bucket (prerequisite 6).
- Whether to suspend versioning in a revert.
- Encryption (SSE-S3 or a KMS key) and replication, which this command does not apply.

## Not covered here

- The 7-year cold retention of the audit archive is a separate feature.
- Creating the bucket, the IAM roles and the replica: provider tooling, owner only.
