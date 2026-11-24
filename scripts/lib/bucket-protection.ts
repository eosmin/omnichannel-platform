import {
  DeleteBucketLifecycleCommand,
  GetBucketEncryptionCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketVersioningCommand,
  PutBucketLifecycleConfigurationCommand,
  PutBucketVersioningCommand,
  type LifecycleRule,
  type TransitionDefaultMinimumObjectSize,
  type S3Client
} from '@aws-sdk/client-s3'

// The logic of scripts/bucket-protection.ts (the operator's command that applies the protection of the production bucket,
// docs/BUCKET_PROTECTION_RUNBOOK.md). Everything here talks to the bucket through `BucketPort`, so the specs run it against an
// in-memory S3 with no network and no credentials. The code of the api and the worker only WATCHES the protection
// (StorageService.inspectProtection); this is what APPLIES it.

export const BucketProtectionModes = {
  STATUS: 'status',
  APPLY: 'apply',
  REVERT: 'revert'
} as const
export type BucketProtectionMode =
  (typeof BucketProtectionModes)[keyof typeof BucketProtectionModes]
export const BUCKET_PROTECTION_MODES: readonly BucketProtectionMode[] =
  Object.values(BucketProtectionModes)

// The one lifecycle rule this script owns. Every other rule of the bucket belongs to somebody else and is never touched.
// The legacy id is the one the command pasted in TDD_03 §7.3 used before this script existed: a bucket where an operator ran
// that command by hand gets the rule replaced, not duplicated.
export const MANAGED_RULE_ID = 'platform-bucket-protection'
export const LEGACY_MANAGED_RULE_IDS: readonly string[] = ['expire-noncurrent']

// The owner's decision of 2026-11-21 (TDD_03 §7.3). Both are editable per run with a flag.
export const BucketProtectionDefaults = {
  NONCURRENT_DAYS: 30,
  ABORT_MULTIPART_DAYS: 7
} as const
const MAX_DAYS = 3650

// The bucket of the local SeaweedFS of docker-compose and of the CI jobs. A hosted bucket is never called this.
export const LOCAL_BUCKET_NAMES: readonly string[] = ['platform-dev']

export const VersioningStates = {
  ENABLED: 'Enabled',
  SUSPENDED: 'Suspended',
  UNVERSIONED: 'Unversioned'
} as const
export type VersioningState = (typeof VersioningStates)[keyof typeof VersioningStates]

export const EncryptionStates = { NONE: 'none', UNKNOWN: 'unknown' } as const

export interface BucketProtectionOptions {
  mode: BucketProtectionMode
  confirm: string | undefined
  noncurrentDays: number
  abortMultipartDays: number
  suspendVersioning: boolean
}

export interface BucketLifecycle {
  rules: LifecycleRule[]
  // Part of the configuration, not of a rule: PutBucketLifecycleConfiguration resets it to the default when it is left out
  transitionDefaultMinimumObjectSize: TransitionDefaultMinimumObjectSize | undefined
}

export interface BucketPort {
  getVersioning(): Promise<{ status: VersioningState; mfaDelete: boolean }>
  putVersioning(
    status: typeof VersioningStates.ENABLED | typeof VersioningStates.SUSPENDED
  ): Promise<void>
  // No configuration at all reads as an empty list; any other failure (access denied, a provider that does not answer) throws,
  // so that an unreadable configuration is never taken for an empty one and replaced
  getLifecycle(): Promise<BucketLifecycle>
  putLifecycle(lifecycle: BucketLifecycle): Promise<void>
  deleteLifecycle(): Promise<void>
  // The algorithm, EncryptionStates.NONE when the bucket has none; it throws when the store does not say
  getEncryption(): Promise<string>
}

type Sender = Pick<S3Client, 'send'>

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : ''
}

export function describeError(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return text.length > 300 ? `${text.slice(0, 300)}...` : text
}

export function s3BucketPort(client: Sender, bucket: string): BucketPort {
  return {
    async getVersioning() {
      const answer = await client.send(new GetBucketVersioningCommand({ Bucket: bucket }))
      const status =
        answer.Status === 'Enabled'
          ? VersioningStates.ENABLED
          : answer.Status === 'Suspended'
            ? VersioningStates.SUSPENDED
            : VersioningStates.UNVERSIONED
      return { status, mfaDelete: answer.MFADelete === 'Enabled' }
    },
    async putVersioning(status) {
      await client.send(
        new PutBucketVersioningCommand({
          Bucket: bucket,
          VersioningConfiguration: { Status: status }
        })
      )
    },
    async getLifecycle() {
      try {
        const answer = await client.send(
          new GetBucketLifecycleConfigurationCommand({ Bucket: bucket })
        )
        return {
          rules: answer.Rules ?? [],
          transitionDefaultMinimumObjectSize: answer.TransitionDefaultMinimumObjectSize
        }
      } catch (error) {
        if (errorName(error) === 'NoSuchLifecycleConfiguration') {
          return { rules: [], transitionDefaultMinimumObjectSize: undefined }
        }
        throw error
      }
    },
    async putLifecycle(lifecycle) {
      await client.send(
        new PutBucketLifecycleConfigurationCommand({
          Bucket: bucket,
          LifecycleConfiguration: { Rules: lifecycle.rules },
          ...(lifecycle.transitionDefaultMinimumObjectSize === undefined
            ? {}
            : { TransitionDefaultMinimumObjectSize: lifecycle.transitionDefaultMinimumObjectSize })
        })
      )
    },
    async deleteLifecycle() {
      await client.send(new DeleteBucketLifecycleCommand({ Bucket: bucket }))
    },
    async getEncryption() {
      try {
        const answer = await client.send(new GetBucketEncryptionCommand({ Bucket: bucket }))
        const algorithm =
          answer.ServerSideEncryptionConfiguration?.Rules?.[0]?.ApplyServerSideEncryptionByDefault
            ?.SSEAlgorithm
        return algorithm ?? EncryptionStates.NONE
      } catch (error) {
        if (errorName(error) === 'ServerSideEncryptionConfigurationNotFoundError') {
          return EncryptionStates.NONE
        }
        throw error
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Arguments and the refusals that happen before the first request

export type ParsedArguments = { options: BucketProtectionOptions } | { problem: string }

function readDays(flag: string, raw: string): number | string {
  if (!/^\d+$/.test(raw)) return `${flag} must be a whole number of days`
  const days = Number(raw)
  if (days < 1 || days > MAX_DAYS) return `${flag} must be between 1 and ${MAX_DAYS}`
  return days
}

export function parseBucketProtectionArguments(args: readonly string[]): ParsedArguments {
  let mode: BucketProtectionMode = BucketProtectionModes.STATUS
  let modeSeen = false
  let confirm: string | undefined
  let noncurrentDays: number = BucketProtectionDefaults.NONCURRENT_DAYS
  let abortMultipartDays: number = BucketProtectionDefaults.ABORT_MULTIPART_DAYS
  let suspendVersioning = false
  for (const arg of args) {
    if (!arg.startsWith('--')) {
      const found = BUCKET_PROTECTION_MODES.find(candidate => candidate === arg)
      if (found === undefined || modeSeen) {
        return { problem: `unknown mode "${arg}": use ${BUCKET_PROTECTION_MODES.join(', ')}` }
      }
      mode = found
      modeSeen = true
      continue
    }
    const separator = arg.indexOf('=')
    const flag = separator === -1 ? arg : arg.slice(0, separator)
    const value = separator === -1 ? undefined : arg.slice(separator + 1)
    if (flag === '--suspend-versioning' && value === undefined) {
      suspendVersioning = true
    } else if (flag === '--confirm' && value !== undefined) {
      confirm = value
    } else if (
      (flag === '--noncurrent-days' || flag === '--abort-multipart-days') &&
      value !== undefined
    ) {
      const days = readDays(flag, value)
      if (typeof days === 'string') return { problem: days }
      if (flag === '--noncurrent-days') noncurrentDays = days
      else abortMultipartDays = days
    } else {
      return { problem: `unknown or incomplete option "${flag}"` }
    }
  }
  if (suspendVersioning && mode !== BucketProtectionModes.REVERT) {
    return { problem: '--suspend-versioning only goes with the revert mode' }
  }
  return { options: { mode, confirm, noncurrentDays, abortMultipartDays, suspendVersioning } }
}

// A store that is on this machine or in the compose network of the project (a host with no dot is a service name, such as
// `seaweedfs`), or the name the local bucket has. Real object storage has neither.
export function localTargetProblem(
  bucket: string,
  endpointHost: string | undefined
): string | undefined {
  if (LOCAL_BUCKET_NAMES.includes(bucket)) {
    return `the bucket "${bucket}" is the one of local development`
  }
  if (endpointHost === undefined) return undefined
  const host = endpointHost.toLowerCase().replace(/\.+$/, '')
  const local =
    !host.includes('.') ||
    host === '0.0.0.0' ||
    host.startsWith('127.') ||
    host === '[::1]' ||
    host === '::1' ||
    host === 'host.docker.internal' ||
    host.endsWith('.local') ||
    host.endsWith('.localhost')
  return local ? `the endpoint host "${host}" is a local store` : undefined
}

// The host of an endpoint URL and nothing else: a URL may carry a user and a password, and the port and the path say nothing
export function endpointHostOf(endpoint: string | undefined): string | undefined {
  return endpoint === undefined ? undefined : new URL(endpoint).hostname
}

export function confirmationProblem(
  options: BucketProtectionOptions,
  bucket: string
): string | undefined {
  if (options.mode === BucketProtectionModes.STATUS) return undefined
  if (options.confirm === undefined) {
    return `${options.mode} changes the bucket: run it again with --confirm=${bucket}`
  }
  if (options.confirm !== bucket) {
    return `--confirm names another bucket than the one S3_BUCKET points at (${bucket}): nothing changed`
  }
  return undefined
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The rules

export function managedRule(options: BucketProtectionOptions): LifecycleRule {
  return {
    ID: MANAGED_RULE_ID,
    Status: 'Enabled',
    Filter: { Prefix: '' },
    Expiration: { ExpiredObjectDeleteMarker: true },
    NoncurrentVersionExpiration: { NoncurrentDays: options.noncurrentDays },
    AbortIncompleteMultipartUpload: { DaysAfterInitiation: options.abortMultipartDays }
  }
}

// The rule the command pasted in TDD_03 §7.3 had exactly this shape: the whole bucket, expire the noncurrent versions, abort the
// unfinished uploads, clean the delete markers. A rule with the legacy id and any other content (a prefix, a transition, an
// expiration of current objects, a tag) belongs to somebody else and is kept.
const ONLY = (allowed: string) => (value: object | undefined) =>
  value === undefined ||
  Object.entries(value).every(([key, entry]) => key === allowed || entry === undefined)

function hasLegacyShape(rule: LifecycleRule): boolean {
  const known = [
    'ID',
    'Status',
    'Filter',
    'Prefix',
    'Expiration',
    'NoncurrentVersionExpiration',
    'AbortIncompleteMultipartUpload'
  ]
  const otherFields = Object.entries(rule).filter(
    ([key, value]) => !known.includes(key) && value !== undefined
  )
  const filterOnlyPrefix = ONLY('Prefix')(rule.Filter)
  return (
    otherFields.length === 0 &&
    filterOnlyPrefix &&
    (rule.Filter?.Prefix ?? rule.Prefix ?? '') === '' &&
    ONLY('ExpiredObjectDeleteMarker')(rule.Expiration) &&
    ONLY('NoncurrentDays')(rule.NoncurrentVersionExpiration) &&
    rule.AbortIncompleteMultipartUpload !== undefined
  )
}

export function isManagedRule(rule: LifecycleRule): boolean {
  if (rule.ID === MANAGED_RULE_ID) return true
  return rule.ID !== undefined && LEGACY_MANAGED_RULE_IDS.includes(rule.ID) && hasLegacyShape(rule)
}

// Two rules are the same when every field they carry is the same; the prefix that a server may answer as absent, as `Filter: {}`
// or as an empty string is one value
function signature(rule: LifecycleRule): string {
  const {
    ID,
    Status,
    Filter,
    Prefix,
    Expiration,
    NoncurrentVersionExpiration,
    AbortIncompleteMultipartUpload,
    ...rest
  } = rule
  return JSON.stringify({
    ID,
    Status,
    filter: { ...Filter, Prefix: Filter?.Prefix ?? Prefix ?? '' },
    Expiration,
    NoncurrentVersionExpiration,
    AbortIncompleteMultipartUpload,
    rest
  })
}

export interface MergeResult {
  rules: LifecycleRule[]
  changed: boolean
}

// The rules of the bucket with ours in them. The rules of somebody else stay as they were, in their order; ours replaces the one
// that was there (in its place) or goes last; a second managed rule (the legacy id) goes away.
export function mergeManagedRule(
  existing: readonly LifecycleRule[],
  options: BucketProtectionOptions
): MergeResult {
  const wanted = managedRule(options)
  const rules: LifecycleRule[] = []
  let placed = false
  for (const rule of existing) {
    if (!isManagedRule(rule)) {
      rules.push(rule)
    } else if (!placed) {
      rules.push(wanted)
      placed = true
    }
  }
  if (!placed) rules.push(wanted)
  const same =
    existing.length === rules.length &&
    existing.every((rule, index) => {
      const next = rules[index]
      return next !== undefined && signature(rule) === signature(next)
    })
  return { rules, changed: !same }
}

export function withoutManagedRule(existing: readonly LifecycleRule[]): MergeResult {
  const rules = existing.filter(rule => !isManagedRule(rule))
  return { rules, changed: rules.length !== existing.length }
}

function currentManagedRule(rules: readonly LifecycleRule[]): LifecycleRule | undefined {
  return rules.find(rule => rule.ID === MANAGED_RULE_ID)
}

function ruleIds(rules: readonly LifecycleRule[]): string {
  return rules.map(rule => rule.ID ?? '(no id)').join(', ') || 'none'
}

// A rule of somebody else that also acts on the old versions or the unfinished uploads of the whole bucket: S3 applies every rule,
// so the shortest period wins. Said, never changed.
function overlappingForeignRules(rules: readonly LifecycleRule[]): string[] {
  return rules
    .filter(
      rule =>
        !isManagedRule(rule) &&
        rule.Status === 'Enabled' &&
        (rule.NoncurrentVersionExpiration !== undefined ||
          rule.AbortIncompleteMultipartUpload !== undefined)
    )
    .map(rule => rule.ID ?? '(no id)')
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The run

export interface BucketProtectionContext {
  bucket: string
  region: string
  endpointHost: string | undefined
  port: BucketPort
  log: (line: string) => void
  // The wait between a write and the read that verifies it (the configuration of a bucket may take a moment to be visible)
  sleep: (ms: number) => Promise<void>
}

const VERIFY_ATTEMPTS = 4
const VERIFY_WAIT_MS = 2_000

interface Snapshot {
  versioning: VersioningState
  mfaDelete: boolean
  lifecycle: BucketLifecycle
}

async function readSnapshot(port: BucketPort): Promise<Snapshot> {
  const versioning = await port.getVersioning()
  const lifecycle = await port.getLifecycle()
  return { versioning: versioning.status, mfaDelete: versioning.mfaDelete, lifecycle }
}

function ourRuleIsAsWanted(snapshot: Snapshot, options: BucketProtectionOptions): boolean {
  const ours = currentManagedRule(snapshot.lifecycle.rules)
  return (
    ours !== undefined &&
    !snapshot.lifecycle.rules.some(rule => rule.ID !== MANAGED_RULE_ID && isManagedRule(rule)) &&
    signature(ours) === signature(managedRule(options))
  )
}

function describeOurRule(snapshot: Snapshot, options: BucketProtectionOptions): string {
  const ours = currentManagedRule(snapshot.lifecycle.rules)
  if (ours === undefined) return 'missing'
  const days = `noncurrent versions expire after ${ours.NoncurrentVersionExpiration?.NoncurrentDays ?? 'never'} days, unfinished uploads are aborted after ${ours.AbortIncompleteMultipartUpload?.DaysAfterInitiation ?? 'never'} days`
  return `${ourRuleIsAsWanted(snapshot, options) ? 'present' : 'present but not as asked'} (${days})`
}

async function printStatus(
  context: BucketProtectionContext,
  snapshot: Snapshot,
  options: BucketProtectionOptions
): Promise<boolean> {
  const { log } = context
  let encryption: string
  try {
    encryption = await context.port.getEncryption()
  } catch (error) {
    encryption = `${EncryptionStates.UNKNOWN} (${describeError(error)})`
  }
  const foreign = snapshot.lifecycle.rules.filter(rule => !isManagedRule(rule))
  log(`versioning: ${snapshot.versioning}${snapshot.mfaDelete ? ' (MFA delete is on)' : ''}`)
  log(`encryption (reported, this command does not change it): ${encryption}`)
  log(`lifecycle rule ${MANAGED_RULE_ID}: ${describeOurRule(snapshot, options)}`)
  log(`lifecycle rules of somebody else (never touched): ${ruleIds(foreign)}`)
  const overlapping = overlappingForeignRules(snapshot.lifecycle.rules)
  if (overlapping.length > 0) {
    log(
      `note: ${overlapping.join(', ')} also expire old versions or unfinished uploads; S3 applies every rule, so the shortest period wins`
    )
  }
  const protectedNow =
    snapshot.versioning === VersioningStates.ENABLED && ourRuleIsAsWanted(snapshot, options)
  log(protectedNow ? 'protection: complete' : 'protection: INCOMPLETE')
  return protectedNow
}

async function verified(
  context: BucketProtectionContext,
  holds: (snapshot: Snapshot) => boolean
): Promise<Snapshot | undefined> {
  let last: Snapshot | undefined
  for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await context.sleep(VERIFY_WAIT_MS)
    last = await readSnapshot(context.port)
    if (holds(last)) return last
  }
  return undefined
}

async function apply(
  context: BucketProtectionContext,
  options: BucketProtectionOptions
): Promise<number> {
  const { log, port } = context
  // Read first and write nothing if either read fails: PutBucketLifecycleConfiguration REPLACES every rule, so an unreadable
  // configuration must stop the run, not be taken for an empty one
  const before = await readSnapshot(port)
  if (before.mfaDelete) {
    log(
      'note: MFA delete is on for this bucket; if S3 refuses to change the versioning, that is why'
    )
  }
  if (before.versioning === VersioningStates.ENABLED) {
    log('versioning: already on')
  } else {
    await port.putVersioning(VersioningStates.ENABLED)
    log(`versioning: ${before.versioning} -> Enabled`)
  }

  const merged = mergeManagedRule(before.lifecycle.rules, options)
  if (!merged.changed) {
    log('lifecycle: already as asked, nothing to write')
  } else {
    const previous = before.lifecycle.rules.find(isManagedRule)
    const previousDays = previous?.NoncurrentVersionExpiration?.NoncurrentDays
    if (previousDays === undefined && before.versioning !== VersioningStates.UNVERSIONED) {
      log(
        `warning: versioning was already ${before.versioning}, so the bucket may hold old versions; those older than ${options.noncurrentDays} days are deleted for good at the next lifecycle run`
      )
    } else if (previousDays !== undefined && options.noncurrentDays < previousDays) {
      log(
        `warning: the period of the old versions goes from ${previousDays} to ${options.noncurrentDays} days; the versions older than that are deleted for good at the next lifecycle run`
      )
    }
    // What to put back by hand if the change has to be undone. Rules are configuration, not credentials, but a filter may name
    // internal prefixes: keep the line private (never paste it in an issue or a chat)
    log(`rules before the change (keep this line): ${JSON.stringify(before.lifecycle.rules)}`)
    await port.putLifecycle({
      rules: merged.rules,
      transitionDefaultMinimumObjectSize: before.lifecycle.transitionDefaultMinimumObjectSize
    })
    log(`lifecycle: ${merged.rules.length} rules written (${ruleIds(merged.rules)})`)
  }

  const after = await verified(
    context,
    snapshot =>
      snapshot.versioning === VersioningStates.ENABLED && ourRuleIsAsWanted(snapshot, options)
  )
  if (after === undefined) {
    log('verification FAILED: the bucket does not show the protection yet; run status in a minute')
    return 1
  }
  log('verified:')
  return (await printStatus(context, after, options)) ? 0 : 1
}

async function revert(
  context: BucketProtectionContext,
  options: BucketProtectionOptions
): Promise<number> {
  const { log, port } = context
  const before = await readSnapshot(port)
  const removed = withoutManagedRule(before.lifecycle.rules)
  if (!removed.changed) {
    log('lifecycle: our rule is not there, nothing to remove')
  } else {
    log(`rules before the change (keep this line): ${JSON.stringify(before.lifecycle.rules)}`)
    if (removed.rules.length === 0) {
      await port.deleteLifecycle()
      log('lifecycle: our rule was the only one, the configuration is removed')
      if (before.lifecycle.transitionDefaultMinimumObjectSize !== undefined) {
        log(
          `note: the setting TransitionDefaultMinimumObjectSize (${before.lifecycle.transitionDefaultMinimumObjectSize}) went with the configuration`
        )
      }
    } else {
      await port.putLifecycle({
        rules: removed.rules,
        transitionDefaultMinimumObjectSize: before.lifecycle.transitionDefaultMinimumObjectSize
      })
      log(`lifecycle: our rule removed, ${removed.rules.length} rules of somebody else kept`)
    }
    log(
      'note: the old versions are no longer expired by this command; they stay (and cost storage, and keep deleted customer data) until another rule or hand removes them'
    )
  }
  if (options.suspendVersioning) {
    if (before.versioning === VersioningStates.ENABLED) {
      await port.putVersioning(VersioningStates.SUSPENDED)
      log(
        'versioning: Enabled -> Suspended (the versions already stored stay; the sweeps of the worker stop)'
      )
    } else {
      log(`versioning: ${before.versioning}, nothing to suspend`)
    }
  } else {
    log('versioning: left as it is (use --suspend-versioning to suspend it)')
  }

  const after = await verified(context, snapshot => {
    const ruleGone = !snapshot.lifecycle.rules.some(isManagedRule)
    const versioningAsAsked =
      !options.suspendVersioning ||
      before.versioning !== VersioningStates.ENABLED ||
      snapshot.versioning === VersioningStates.SUSPENDED
    return ruleGone && versioningAsAsked
  })
  if (after === undefined) {
    log('verification FAILED: the bucket still shows the old state; run status in a minute')
    return 1
  }
  log('verified:')
  await printStatus(context, after, options)
  return 0
}

// 0 done and verified, 1 failed or protection incomplete (status), 2 refused before the first request
export async function runBucketProtection(
  context: BucketProtectionContext,
  options: BucketProtectionOptions
): Promise<number> {
  const { log } = context
  const refusal =
    localTargetProblem(context.bucket, context.endpointHost) ??
    confirmationProblem(options, context.bucket)
  if (refusal !== undefined) {
    log(refusal)
    return 2
  }
  log(
    `bucket ${context.bucket}, region ${context.region}${context.endpointHost === undefined ? '' : `, endpoint ${context.endpointHost}`}, mode ${options.mode}`
  )
  try {
    if (options.mode === BucketProtectionModes.STATUS) {
      const snapshot = await readSnapshot(context.port)
      return (await printStatus(context, snapshot, options)) ? 0 : 1
    }
    return options.mode === BucketProtectionModes.APPLY
      ? await apply(context, options)
      : await revert(context, options)
  } catch (error) {
    log(`failed: ${describeError(error)}`)
    log('Nothing after the failed request was done. It is safe to run the command again.')
    return 1
  }
}
