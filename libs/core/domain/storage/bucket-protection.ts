// What the bucket of the object storage must have in a deployed environment (TDD_03 §7.3): the bytes encrypted at rest and
// versioning on, so an overwritten or deleted object can be recovered. Nothing in the repository provisions a production
// bucket (SeaweedFS makes the local one), so the api looks at it when it starts and says when something is missing.
export const BucketProtections = {
  ENCRYPTION: 'encryption',
  VERSIONING: 'versioning'
} as const
export type BucketProtection = (typeof BucketProtections)[keyof typeof BucketProtections]

// `unknown` is a store that does not answer the question (a role without s3:GetEncryptionConfiguration, a compatible
// store without the call): it is said apart from a protection that is known to be off
export const BucketProtectionStates = {
  ON: 'on',
  OFF: 'off',
  UNKNOWN: 'unknown'
} as const
export type BucketProtectionState = (typeof BucketProtectionStates)[keyof typeof BucketProtectionStates]

export type BucketProtectionReport = Record<BucketProtection, BucketProtectionState>

// The protections a report does not show as on, in a fixed order: an unknown one counts, because a bucket that cannot be
// shown to be protected is not shown to be safe
export function bucketProtectionGaps(report: BucketProtectionReport): BucketProtection[] {
  return Object.values(BucketProtections).filter(
    protection => report[protection] !== BucketProtectionStates.ON
  )
}
