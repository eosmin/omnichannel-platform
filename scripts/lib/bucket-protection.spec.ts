import {
  DeleteBucketLifecycleCommand,
  GetBucketEncryptionCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketVersioningCommand,
  PutBucketLifecycleConfigurationCommand,
  PutBucketVersioningCommand,
  type LifecycleRule
} from '@aws-sdk/client-s3'

import {
  BucketProtectionDefaults,
  BucketProtectionModes,
  LEGACY_MANAGED_RULE_IDS,
  MANAGED_RULE_ID,
  endpointHostOf,
  localTargetProblem,
  mergeManagedRule,
  parseBucketProtectionArguments,
  runBucketProtection,
  s3BucketPort,
  type BucketProtectionOptions
} from './bucket-protection'

const BUCKET = 'acme-platform-production'

class AwsError extends Error {
  constructor(name: string, message = name) {
    super(message)
    this.name = name
  }
}

// An S3 that lives in memory: it answers the six commands of the script and records every request it was sent
class FakeS3 {
  versioning: 'Enabled' | 'Suspended' | undefined
  rules: LifecycleRule[] | undefined
  transitionDefaultMinimumObjectSize: string | undefined
  encryption: string | undefined = 'AES256'
  failOn: Record<string, AwsError> = {}
  sent: string[] = []
  // A write that the store accepts but shows only after this many reads (eventual consistency of a bucket configuration)
  hiddenReads = 0
  private hidden: LifecycleRule[] | undefined

  constructor(init: { versioning?: 'Enabled' | 'Suspended'; rules?: LifecycleRule[] } = {}) {
    this.versioning = init.versioning
    this.rules = init.rules
  }

  get writes(): string[] {
    return this.sent.filter(name => name.startsWith('Put') || name.startsWith('Delete'))
  }

  send(command: unknown): Promise<unknown> {
    try {
      return Promise.resolve(this.answer(command))
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private answer(command: unknown): unknown {
    const name = (command as { constructor: { name: string } }).constructor.name
    this.sent.push(name)
    const failure = this.failOn[name]
    if (failure !== undefined) throw failure
    if (command instanceof GetBucketVersioningCommand) {
      return this.versioning === undefined ? {} : { Status: this.versioning }
    }
    if (command instanceof PutBucketVersioningCommand) {
      const status = command.input.VersioningConfiguration?.Status
      if (status === 'Enabled' || status === 'Suspended') this.versioning = status
      return {}
    }
    if (command instanceof GetBucketLifecycleConfigurationCommand) {
      if (this.hiddenReads > 0 && this.hidden !== undefined) {
        this.hiddenReads -= 1
        return { Rules: this.hidden }
      }
      if (this.rules === undefined) throw new AwsError('NoSuchLifecycleConfiguration')
      return {
        Rules: structuredClone(this.rules),
        TransitionDefaultMinimumObjectSize: this.transitionDefaultMinimumObjectSize
      }
    }
    if (command instanceof PutBucketLifecycleConfigurationCommand) {
      this.hidden = this.rules
      this.rules = structuredClone(command.input.LifecycleConfiguration?.Rules ?? [])
      this.transitionDefaultMinimumObjectSize = command.input.TransitionDefaultMinimumObjectSize
      return {}
    }
    if (command instanceof DeleteBucketLifecycleCommand) {
      this.hidden = this.rules
      this.rules = undefined
      return {}
    }
    if (command instanceof GetBucketEncryptionCommand) {
      if (this.encryption === undefined) {
        throw new AwsError('ServerSideEncryptionConfigurationNotFoundError')
      }
      return {
        ServerSideEncryptionConfiguration: {
          Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: this.encryption } }]
        }
      }
    }
    throw new Error(`unexpected command ${name}`)
  }
}

const OTHERS: LifecycleRule[] = [
  {
    ID: 'logs-to-glacier',
    Status: 'Enabled',
    Filter: { Prefix: 'logs/' },
    Transitions: [{ Days: 90, StorageClass: 'GLACIER' }]
  },
  {
    ID: 'tmp-expire',
    Status: 'Enabled',
    Filter: { Prefix: 'tmp/' },
    Expiration: { Days: 2 }
  }
]

function options(overrides: Partial<BucketProtectionOptions> = {}): BucketProtectionOptions {
  return {
    mode: BucketProtectionModes.APPLY,
    confirm: BUCKET,
    noncurrentDays: BucketProtectionDefaults.NONCURRENT_DAYS,
    abortMultipartDays: BucketProtectionDefaults.ABORT_MULTIPART_DAYS,
    suspendVersioning: false,
    ...overrides
  }
}

async function run(
  fake: FakeS3,
  runOptions: BucketProtectionOptions,
  extra: { bucket?: string; endpointHost?: string } = {}
): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = []
  const bucket = extra.bucket ?? BUCKET
  const code = await runBucketProtection(
    {
      bucket,
      region: 'us-east-1',
      endpointHost: extra.endpointHost,
      port: s3BucketPort(fake, bucket),
      log: line => lines.push(line),
      sleep: () => Promise.resolve()
    },
    runOptions
  )
  return { code, lines }
}

describe('apply', () => {
  it('turns versioning on and writes our rule on a bucket with nothing', async () => {
    const fake = new FakeS3()
    const { code } = await run(fake, options())
    expect(code).toBe(0)
    expect(fake.versioning).toBe('Enabled')
    expect(fake.rules).toEqual([
      {
        ID: MANAGED_RULE_ID,
        Status: 'Enabled',
        Filter: { Prefix: '' },
        Expiration: { ExpiredObjectDeleteMarker: true },
        NoncurrentVersionExpiration: { NoncurrentDays: 30 },
        AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 }
      }
    ])
  })

  it('keeps the rules of somebody else, untouched and in their order, when it adds ours', async () => {
    const fake = new FakeS3({ versioning: 'Suspended', rules: structuredClone(OTHERS) })
    const { code } = await run(fake, options())
    expect(code).toBe(0)
    expect(fake.rules?.slice(0, 2)).toEqual(OTHERS)
    expect(fake.rules?.map(rule => rule.ID)).toEqual([
      'logs-to-glacier',
      'tmp-expire',
      MANAGED_RULE_ID
    ])
    expect(fake.versioning).toBe('Enabled')
  })

  it('keeps the minimum object size setting of the configuration, which a put would otherwise reset', async () => {
    const fake = new FakeS3({ rules: structuredClone(OTHERS) })
    fake.transitionDefaultMinimumObjectSize = 'all_storage_classes_128K'
    await run(fake, options())
    expect(fake.transitionDefaultMinimumObjectSize).toBe('all_storage_classes_128K')
  })

  it('changes our rule in place, with the new periods, and says when the period of the old versions shrinks', async () => {
    const fake = new FakeS3({ versioning: 'Enabled', rules: structuredClone(OTHERS) })
    await run(fake, options())
    const { code, lines } = await run(fake, options({ noncurrentDays: 10, abortMultipartDays: 3 }))
    expect(code).toBe(0)
    expect(fake.rules).toHaveLength(3)
    expect(fake.rules?.[2]?.NoncurrentVersionExpiration).toEqual({ NoncurrentDays: 10 })
    expect(fake.rules?.[2]?.AbortIncompleteMultipartUpload).toEqual({ DaysAfterInitiation: 3 })
    expect(
      lines.some(line =>
        line.startsWith('warning: the period of the old versions goes from 30 to 10')
      )
    ).toBe(true)
  })

  it('replaces the rule of the legacy id instead of adding a second one', async () => {
    const legacyId = LEGACY_MANAGED_RULE_IDS[0]
    const fake = new FakeS3({
      versioning: 'Enabled',
      rules: [
        {
          ID: legacyId,
          Status: 'Enabled',
          Filter: {},
          Expiration: { ExpiredObjectDeleteMarker: true },
          NoncurrentVersionExpiration: { NoncurrentDays: 30 },
          AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 }
        },
        ...structuredClone(OTHERS)
      ]
    })
    await run(fake, options())
    expect(fake.rules?.map(rule => rule.ID)).toEqual([
      MANAGED_RULE_ID,
      'logs-to-glacier',
      'tmp-expire'
    ])
  })

  it('is idempotent: the second run sends no write', async () => {
    const fake = new FakeS3({ rules: structuredClone(OTHERS) })
    await run(fake, options())
    const writesAfterFirst = fake.writes.length
    const second = await run(fake, options())
    expect(second.code).toBe(0)
    expect(fake.writes).toHaveLength(writesAfterFirst)
    expect(second.lines).toContain('lifecycle: already as asked, nothing to write')
  })

  it('reads a server that answers the rule with an absent filter as the same rule', async () => {
    const fake = new FakeS3({
      versioning: 'Enabled',
      rules: [
        {
          ID: MANAGED_RULE_ID,
          Status: 'Enabled',
          Filter: {},
          Expiration: { ExpiredObjectDeleteMarker: true },
          NoncurrentVersionExpiration: { NoncurrentDays: 30 },
          AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 }
        }
      ]
    })
    const { code } = await run(fake, options())
    expect(code).toBe(0)
    expect(fake.writes).toEqual([])
  })

  it('writes nothing when the lifecycle cannot be read (a replace would erase rules it never saw)', async () => {
    const fake = new FakeS3({ rules: structuredClone(OTHERS) })
    fake.failOn.GetBucketLifecycleConfigurationCommand = new AwsError(
      'AccessDenied',
      'Access Denied'
    )
    const { code, lines } = await run(fake, options())
    expect(code).toBe(1)
    expect(fake.writes).toEqual([])
    expect(fake.rules).toEqual(OTHERS)
    expect(lines.some(line => line.includes('AccessDenied'))).toBe(true)
  })

  it('writes nothing when versioning cannot be read', async () => {
    const fake = new FakeS3()
    fake.failOn.GetBucketVersioningCommand = new AwsError('AccessDenied')
    const { code } = await run(fake, options())
    expect(code).toBe(1)
    expect(fake.writes).toEqual([])
  })

  it('does not touch the lifecycle when versioning could not be turned on', async () => {
    const fake = new FakeS3({ rules: structuredClone(OTHERS) })
    fake.failOn.PutBucketVersioningCommand = new AwsError('AccessDenied')
    const { code } = await run(fake, options())
    expect(code).toBe(1)
    expect(fake.writes).toEqual(['PutBucketVersioningCommand'])
    expect(fake.rules).toEqual(OTHERS)
  })

  it('waits for a configuration that is not visible yet and then verifies', async () => {
    const fake = new FakeS3({ versioning: 'Enabled', rules: structuredClone(OTHERS) })
    fake.hiddenReads = 2
    const { code } = await run(fake, options())
    expect(code).toBe(0)
  })

  it('fails the verification when the bucket never shows the rule', async () => {
    const fake = new FakeS3({ versioning: 'Enabled', rules: structuredClone(OTHERS) })
    fake.hiddenReads = 99
    const { code, lines } = await run(fake, options())
    expect(code).toBe(1)
    expect(lines.some(line => line.startsWith('verification FAILED'))).toBe(true)
  })
})

describe('refusals before the first request', () => {
  it.each([undefined, 'another-bucket'])(
    'refuses to change the bucket with --confirm=%s',
    async confirm => {
      const fake = new FakeS3()
      const { code } = await run(fake, options({ confirm }))
      expect(code).toBe(2)
      expect(fake.sent).toEqual([])
    }
  )

  it('refuses revert without --confirm as well', async () => {
    const fake = new FakeS3({ versioning: 'Enabled', rules: structuredClone(OTHERS) })
    const { code } = await run(
      fake,
      options({ mode: BucketProtectionModes.REVERT, confirm: undefined })
    )
    expect(code).toBe(2)
    expect(fake.sent).toEqual([])
  })

  it('refuses the bucket of local development even with the right --confirm', async () => {
    const fake = new FakeS3()
    const { code, lines } = await run(fake, options({ confirm: 'platform-dev' }), {
      bucket: 'platform-dev'
    })
    expect(code).toBe(2)
    expect(fake.sent).toEqual([])
    expect(lines[0]).toContain('local development')
  })

  it.each(['localhost', '127.0.0.1', 'seaweedfs', '0.0.0.0', 'store.local'])(
    'refuses a local store at %s',
    async host => {
      const fake = new FakeS3()
      const { code } = await run(fake, options(), { endpointHost: host })
      expect(code).toBe(2)
      expect(fake.sent).toEqual([])
    }
  )

  it('lets a hosted endpoint through', () => {
    expect(localTargetProblem(BUCKET, 's3.eu-west-1.amazonaws.com')).toBeUndefined()
    expect(localTargetProblem(BUCKET, undefined)).toBeUndefined()
  })

  it('refuses status on the local bucket too, so a wrong environment is noticed', async () => {
    const fake = new FakeS3()
    const { code } = await run(
      fake,
      options({ mode: BucketProtectionModes.STATUS, confirm: undefined }),
      { bucket: 'platform-dev' }
    )
    expect(code).toBe(2)
    expect(fake.sent).toEqual([])
  })
})

describe('status', () => {
  it('only reads, and exits 1 while the protection is incomplete', async () => {
    const fake = new FakeS3({ rules: structuredClone(OTHERS) })
    const { code, lines } = await run(
      fake,
      options({ mode: BucketProtectionModes.STATUS, confirm: undefined })
    )
    expect(code).toBe(1)
    expect(fake.writes).toEqual([])
    expect(lines).toContain('versioning: Unversioned')
    expect(lines).toContain('protection: INCOMPLETE')
  })

  it('exits 0 once apply has run, and says so about the encryption it only reports', async () => {
    const fake = new FakeS3()
    fake.encryption = undefined
    await run(fake, options())
    const { code, lines } = await run(
      fake,
      options({ mode: BucketProtectionModes.STATUS, confirm: undefined })
    )
    expect(code).toBe(0)
    expect(lines.some(line => line.includes('encryption') && line.endsWith('none'))).toBe(true)
  })

  it('reports an unreadable encryption as unknown without failing', async () => {
    const fake = new FakeS3()
    fake.failOn.GetBucketEncryptionCommand = new AwsError('AccessDenied')
    const { lines } = await run(
      fake,
      options({ mode: BucketProtectionModes.STATUS, confirm: undefined })
    )
    expect(lines.some(line => line.includes('encryption') && line.includes('unknown'))).toBe(true)
  })

  it('names a rule of somebody else that also expires old versions', async () => {
    const fake = new FakeS3({
      versioning: 'Enabled',
      rules: [
        {
          ID: 'theirs',
          Status: 'Enabled',
          Filter: {},
          NoncurrentVersionExpiration: { NoncurrentDays: 5 }
        }
      ]
    })
    const { lines } = await run(
      fake,
      options({ mode: BucketProtectionModes.STATUS, confirm: undefined })
    )
    expect(lines.some(line => line.startsWith('note: theirs also expire'))).toBe(true)
  })
})

describe('revert', () => {
  const revertOptions = options({ mode: BucketProtectionModes.REVERT })

  it('removes only our rule and leaves versioning on', async () => {
    const fake = new FakeS3({ rules: structuredClone(OTHERS) })
    await run(fake, options())
    const { code } = await run(fake, revertOptions)
    expect(code).toBe(0)
    expect(fake.rules).toEqual(OTHERS)
    expect(fake.versioning).toBe('Enabled')
  })

  it('removes the whole configuration when ours was the only rule', async () => {
    const fake = new FakeS3()
    await run(fake, options())
    await run(fake, revertOptions)
    expect(fake.rules).toBeUndefined()
  })

  it('suspends versioning only when asked to', async () => {
    const fake = new FakeS3()
    await run(fake, options())
    await run(fake, options({ mode: BucketProtectionModes.REVERT, suspendVersioning: true }))
    expect(fake.versioning).toBe('Suspended')
  })

  it('is idempotent', async () => {
    const fake = new FakeS3({ versioning: 'Enabled', rules: structuredClone(OTHERS) })
    const { code } = await run(fake, revertOptions)
    expect(code).toBe(0)
    expect(fake.writes).toEqual([])
  })
})

describe('mergeManagedRule', () => {
  it('reports no change for a bucket that already has our rule as asked', () => {
    const first = mergeManagedRule(OTHERS, options())
    expect(first.changed).toBe(true)
    expect(mergeManagedRule(first.rules, options()).changed).toBe(false)
  })
})

describe('parseBucketProtectionArguments', () => {
  it('defaults to status with the periods of the owner', () => {
    expect(parseBucketProtectionArguments([])).toEqual({
      options: {
        mode: 'status',
        confirm: undefined,
        noncurrentDays: 30,
        abortMultipartDays: 7,
        suspendVersioning: false
      }
    })
  })

  it('reads a mode, the confirmation and the editable periods', () => {
    expect(
      parseBucketProtectionArguments([
        'apply',
        `--confirm=${BUCKET}`,
        '--noncurrent-days=45',
        '--abort-multipart-days=3'
      ])
    ).toEqual({
      options: {
        mode: 'apply',
        confirm: BUCKET,
        noncurrentDays: 45,
        abortMultipartDays: 3,
        suspendVersioning: false
      }
    })
  })

  it.each([
    [['delete']],
    [['apply', 'revert']],
    [['--noncurrent-days=0']],
    [['--noncurrent-days=abc']],
    [['--noncurrent-days=99999']],
    [['--abort-multipart-days=1.5']],
    [['--confirm']],
    [['--force']],
    [['apply', '--suspend-versioning']]
  ])('refuses %j', args => {
    expect(parseBucketProtectionArguments(args)).toHaveProperty('problem')
  })
})

describe('rules of somebody else under the legacy id', () => {
  const legacyId = LEGACY_MANAGED_RULE_IDS[0]
  const theirs: LifecycleRule = {
    ID: legacyId,
    Status: 'Enabled',
    Filter: { Prefix: 'invoices/' },
    Transitions: [{ Days: 90, StorageClass: 'GLACIER' }]
  }

  it.each([
    ['a prefix', { ...theirs, Transitions: undefined }],
    ['a transition', { ...theirs, Filter: { Prefix: '' } }],
    [
      'an expiration of current objects',
      { ID: legacyId, Status: 'Enabled', Filter: {}, Expiration: { Days: 30 } }
    ]
  ])('keeps it on apply and on revert when it has %s', async (_name, rule) => {
    const fake = new FakeS3({ versioning: 'Enabled', rules: [structuredClone(rule)] })
    await run(fake, options())
    expect(fake.rules?.map(entry => entry.ID)).toEqual([legacyId, MANAGED_RULE_ID])
    await run(fake, options({ mode: BucketProtectionModes.REVERT }))
    expect(fake.rules).toHaveLength(1)
    expect(fake.rules?.[0]?.ID).toBe(legacyId)
  })
})

describe('warnings about deleting old versions', () => {
  it('warns on the first apply of a bucket whose versioning is already on or suspended', async () => {
    const fake = new FakeS3({ versioning: 'Suspended' })
    const { lines } = await run(fake, options())
    expect(lines.some(line => line.startsWith('warning: versioning was already Suspended'))).toBe(
      true
    )
  })

  it('does not warn on a bucket that never had versioning', async () => {
    const { lines } = await run(new FakeS3(), options())
    expect(lines.some(line => line.startsWith('warning'))).toBe(false)
  })

  it('warns when the rule of the legacy id is replaced by a shorter period', async () => {
    const fake = new FakeS3({
      versioning: 'Enabled',
      rules: [
        {
          ID: LEGACY_MANAGED_RULE_IDS[0],
          Status: 'Enabled',
          Filter: {},
          Expiration: { ExpiredObjectDeleteMarker: true },
          NoncurrentVersionExpiration: { NoncurrentDays: 90 },
          AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 }
        }
      ]
    })
    const { lines } = await run(fake, options())
    expect(lines.some(line => line.includes('goes from 90 to 30'))).toBe(true)
  })
})

describe('revert, the cases that fail', () => {
  it('keeps the minimum object size setting when rules of somebody else stay', async () => {
    const fake = new FakeS3({ rules: structuredClone(OTHERS) })
    fake.transitionDefaultMinimumObjectSize = 'all_storage_classes_128K'
    await run(fake, options())
    await run(fake, options({ mode: BucketProtectionModes.REVERT }))
    expect(fake.transitionDefaultMinimumObjectSize).toBe('all_storage_classes_128K')
  })

  it('says that the setting goes when the whole configuration is removed', async () => {
    const fake = new FakeS3()
    await run(fake, options())
    fake.transitionDefaultMinimumObjectSize = 'all_storage_classes_128K'
    const { lines } = await run(fake, options({ mode: BucketProtectionModes.REVERT }))
    expect(lines.some(line => line.includes('TransitionDefaultMinimumObjectSize'))).toBe(true)
  })

  it('writes nothing when the rules cannot be read', async () => {
    const fake = new FakeS3({ versioning: 'Enabled', rules: structuredClone(OTHERS) })
    fake.failOn.GetBucketLifecycleConfigurationCommand = new AwsError('AccessDenied')
    const { code } = await run(fake, options({ mode: BucketProtectionModes.REVERT }))
    expect(code).toBe(1)
    expect(fake.writes).toEqual([])
  })

  it('fails the verification when the bucket keeps showing the rule', async () => {
    const fake = new FakeS3()
    await run(fake, options())
    fake.hiddenReads = 99
    const { code } = await run(fake, options({ mode: BucketProtectionModes.REVERT }))
    expect(code).toBe(1)
  })
})

describe('endpoints', () => {
  it('reads the host only, never a user or a password', () => {
    const host = endpointHostOf('https://operator:hunter2@s3.example.com:9000/path')
    expect(host).toBe('s3.example.com')
    expect(endpointHostOf(undefined)).toBeUndefined()
  })

  it.each(['localhost.', '::1', '[::1]', 'host.docker.internal'])(
    'refuses %s as a local store',
    host => {
      expect(localTargetProblem(BUCKET, host)).toBeDefined()
    }
  )
})
