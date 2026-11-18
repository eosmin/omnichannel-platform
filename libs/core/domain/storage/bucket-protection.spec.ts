import {
  bucketProtectionGaps,
  BucketProtections,
  BucketProtectionStates,
  type BucketProtectionReport
} from './bucket-protection'

const { ON, OFF, UNKNOWN } = BucketProtectionStates

const report = (
  encryption: BucketProtectionReport['encryption'],
  versioning: BucketProtectionReport['versioning']
): BucketProtectionReport => ({
  [BucketProtections.ENCRYPTION]: encryption,
  [BucketProtections.VERSIONING]: versioning
})

describe('bucketProtectionGaps', () => {
  it('is empty when both protections are on', () => {
    expect(bucketProtectionGaps(report(ON, ON))).toEqual([])
  })

  it('names what is off', () => {
    expect(bucketProtectionGaps(report(OFF, ON))).toEqual([BucketProtections.ENCRYPTION])
    expect(bucketProtectionGaps(report(ON, OFF))).toEqual([BucketProtections.VERSIONING])
    expect(bucketProtectionGaps(report(OFF, OFF))).toEqual([
      BucketProtections.ENCRYPTION,
      BucketProtections.VERSIONING
    ])
  })

  it('counts an answer it could not get as a gap', () => {
    expect(bucketProtectionGaps(report(UNKNOWN, ON))).toEqual([BucketProtections.ENCRYPTION])
  })
})
