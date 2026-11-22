import {
  clamavImageOf,
  findShardProblems,
  matrixOf,
  projectShardList,
  type ShardSources
} from './ci-shards'

const eighths = "['1/8', '2/8', '3/8', '4/8', '5/8', '6/8', '7/8', '8/8']"

function workflow(
  overrides: { security?: string; rls?: string; e2e?: string; needs?: string } = {}
): string {
  return `
jobs:
  lint:
    runs-on: ubuntu-latest
  security-shards:
    strategy:
      matrix:
        # a comment with shard: ['9/9'] in it must not count
        shard: ${overrides.security ?? eighths}
    runs-on: ubuntu-latest
  security-isolated-specs:
    runs-on: ubuntu-latest
  security-tests:
    needs: ${overrides.needs ?? '[security-shards, security-isolated-specs]'}
    if: always()
  rls-enforced-security:
    strategy:
      matrix:
        shard: ${overrides.rls ?? eighths}
  e2e-shards:
    strategy:
      matrix:
        ${overrides.e2e ?? 'shard: [1, 2, 3]\n        total: [3]'}
  other:
    runs-on: ubuntu-latest
`
}

const projectCommand =
  'if [ -n "$SECURITY_SHARD" ]; then jest --shard="$SECURITY_SHARD"; else status=0; for shard in 1/8 2/8 3/8 4/8 5/8 6/8 7/8 8/8; do jest --shard="$shard" || status=1; done; exit $status; fi'

function sources(overrides: Partial<ShardSources> = {}): ShardSources {
  return {
    workflow: workflow(),
    securityCommand: projectCommand,
    composeClamav: 'clamav/clamav:1.5.4-debian',
    actionClamav: 'clamav/clamav:1.5.4-debian',
    ...overrides
  }
}

describe('matrixOf', () => {
  it('reads the list of a job and skips comments', () => {
    expect(matrixOf(workflow(), 'security-shards', 'shard')).toEqual([
      '1/8',
      '2/8',
      '3/8',
      '4/8',
      '5/8',
      '6/8',
      '7/8',
      '8/8'
    ])
  })

  it('does not read the list of the next job', () => {
    expect(matrixOf(workflow(), 'security-isolated-specs', 'shard')).toBeNull()
  })

  it('reads numbers as they are written', () => {
    expect(matrixOf(workflow(), 'e2e-shards', 'total')).toEqual(['3'])
  })
})

describe('projectShardList', () => {
  it('reads the shards of the local loop', () => {
    expect(projectShardList(projectCommand)).toHaveLength(8)
  })

  it('is null without a loop', () => {
    expect(projectShardList('jest')).toBeNull()
  })
})

describe('clamavImageOf', () => {
  it('finds the image in a compose file and in an action', () => {
    expect(clamavImageOf('    image: clamav/clamav:1.5.4-debian\n')).toBe(
      'clamav/clamav:1.5.4-debian'
    )
    expect(clamavImageOf('            clamav/clamav:1.5.4-debian\n')).toBe(
      'clamav/clamav:1.5.4-debian'
    )
    expect(clamavImageOf('nothing')).toBeNull()
  })
})

describe('findShardProblems', () => {
  it('accepts a consistent setup', () => {
    expect(findShardProblems(sources())).toEqual([])
  })

  it('fails when a leg is missing (specs that no job runs)', () => {
    const problems = findShardProblems(
      sources({
        workflow: workflow({ security: "['1/8', '2/8', '3/8', '4/8', '5/8', '6/8', '7/8']" })
      })
    )
    expect(problems.join('\n')).toMatch(/security-shards.*1\/8 to 8\/8/)
  })

  it('fails when a leg is repeated or from another denominator', () => {
    expect(
      findShardProblems(
        sources({
          workflow: workflow({ rls: "['1/8', '2/8', '2/8', '4/8', '5/8', '6/8', '7/8', '8/8']" })
        })
      ).length
    ).toBeGreaterThan(0)
    expect(
      findShardProblems(
        sources({ workflow: workflow({ rls: "['1/6', '2/6', '3/6', '4/6', '5/6', '6/6']" }) })
      ).join('\n')
    ).toMatch(/rls-enforced-security/)
  })

  it('fails when the two jobs of the suite do not use the same denominator', () => {
    const problems = findShardProblems(
      sources({ workflow: workflow({ rls: "['1/6', '2/6', '3/6', '4/6', '5/6', '6/6']" }) })
    )
    expect(problems.join('\n')).toMatch(/same denominator/)
  })

  it('fails when the local loop of tests/project.json drifts from the matrix', () => {
    const problems = findShardProblems(
      sources({ securityCommand: projectCommand.replace(' 8/8;', ';') })
    )
    expect(problems.join('\n')).toMatch(/tests\/project\.json/)
  })

  it('fails when the aggregator does not wait for the isolated specs', () => {
    const problems = findShardProblems(
      sources({ workflow: workflow({ needs: '[security-shards]' }) })
    )
    expect(problems.join('\n')).toMatch(/security-tests.*security-isolated-specs/)
  })

  it('fails when the e2e slices and total disagree', () => {
    const problems = findShardProblems(
      sources({ workflow: workflow({ e2e: 'shard: [1, 2, 3]\n        total: [4]' }) })
    )
    expect(problems.join('\n')).toMatch(/e2e-shards/)
  })

  it('fails when the clamav image of the action drifts from the compose file', () => {
    const problems = findShardProblems(sources({ actionClamav: 'clamav/clamav:1.5.5-debian' }))
    expect(problems.join('\n')).toMatch(/clamav/)
  })
})
