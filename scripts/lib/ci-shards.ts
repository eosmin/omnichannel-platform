// The shard counts of the CI live in more than one file: the matrix of `security-shards` and of `rls-enforced-security`
// in `.github/workflows/ci.yml`, the local loop of `tests/project.json` (`pnpm test:security`), and `total` of the e2e
// slices. A leg that goes missing from a matrix leaves specs that no job runs, and the aggregator still reads green. This
// reads them all and says where they disagree (Step 7.3). It reads text, because the repository has no YAML parser and
// the lines it needs are plain.

export interface ShardSources {
  workflow: string
  /** The `command` of the `test-security` target of tests/project.json */
  securityCommand: string
  composeClamav: string | null
  actionClamav: string | null
}

export const SECURITY_JOBS = ['security-shards', 'rls-enforced-security'] as const
export const SECURITY_AGGREGATOR = 'security-tests'
// Run beside the shards, in jobs of their own: the aggregator must wait for each
export const SECURITY_COMPANION_JOBS = ['security-isolated-specs'] as const
export const E2E_JOB = 'e2e-shards'

const withoutComments = (text: string): string =>
  text
    .split('\n')
    .filter(line => !/^\s*#/.test(line))
    .join('\n')

// The lines of one job of the workflow (its header, at two spaces, up to the next job)
function jobBlock(workflow: string, job: string): string | null {
  const lines = withoutComments(workflow).split('\n')
  const start = lines.findIndex(line => line === `  ${job}:`)
  if (start === -1) return null
  const end = lines.findIndex((line, index) => index > start && /^ {2}\S/.test(line))
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n')
}

const splitList = (inner: string): string[] =>
  inner
    .split(',')
    .map(item => item.trim().replace(/^['"]|['"]$/g, ''))
    .filter(item => item !== '')

/** The flow list `key: [a, b]` that a job holds, or null when it holds none */
export function matrixOf(workflow: string, job: string, key: string): string[] | null {
  const block = jobBlock(workflow, job)
  if (block === null) return null
  const match = new RegExp(`^\\s+${key}:\\s*\\[(.*)\\]\\s*$`, 'm').exec(block)
  return match === null ? null : splitList(match[1] ?? '')
}

/** The shards of the `for shard in ...;` of the local run of the suite */
export function projectShardList(command: string): string[] | null {
  const match = /for shard in ([^;]+);/.exec(command)
  return match === null ? null : (match[1] ?? '').split(/\s+/).filter(item => item !== '')
}

/** The image of the scanner in a compose file or in an action */
export function clamavImageOf(text: string): string | null {
  return /clamav\/clamav:[\w.-]+/.exec(text)?.[0] ?? null
}

const denominatorOf = (shard: string): number => Number(shard.split('/')[1])
const expectedShards = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => `${index + 1}/${count}`)

// The legs must be exactly 1/N to N/N, once each, in that order, where N is the denominator they write: a leg
// removed from the list is then a leg that is missing, not a smaller suite
function legsProblem(label: string, legs: string[] | null): string | null {
  if (legs === null || legs.length === 0) return `${label}: no list of shards found`
  const count = denominatorOf(legs[0] ?? '')
  if (!Number.isInteger(count) || count < 1) return `${label}: ${legs[0]} is not a shard (i/N)`
  const expected = expectedShards(count)
  return legs.join(' ') === expected.join(' ')
    ? null
    : `${label}: the shards must be ${expected[0]} to ${expected[count - 1]}, each once, and they are ${legs.join(' ')}`
}

function needsOf(workflow: string, job: string): string[] {
  const block = jobBlock(workflow, job)
  if (block === null) return []
  const inline = /^\s+needs:[ \t]*(\S.*)$/m.exec(block)
  if (inline !== null) return splitList((inline[1] ?? '').replace(/^\[|\]$/g, ''))
  // The block form: `needs:` and then `- job` lines
  const listed = /^\s+needs:\s*\n((?:\s+-\s*\S+\n?)+)/m.exec(block)
  return listed === null
    ? []
    : (listed[1] ?? '')
        .split('\n')
        .map(line => line.replace(/^\s*-\s*/, '').trim())
        .filter(item => item !== '')
}

export function findShardProblems(sources: ShardSources): string[] {
  const problems: string[] = []
  const denominators = new Set<number>()

  for (const job of SECURITY_JOBS) {
    const legs = matrixOf(sources.workflow, job, 'shard')
    const problem = legsProblem(`ci.yml ${job}`, legs)
    if (problem !== null) problems.push(problem)
    else if (legs !== null) denominators.add(denominatorOf(legs[0] ?? ''))
  }
  if (denominators.size > 1) {
    problems.push(
      `ci.yml: ${SECURITY_JOBS.join(' and ')} must use the same denominator (they run the same files), and they use ${[...denominators].join(' and ')}`
    )
  }

  const local = projectShardList(sources.securityCommand)
  const [count] = [...denominators]
  if (local === null) {
    problems.push(
      'tests/project.json: the `for shard in ...;` of the local run of test-security was not found'
    )
  } else if (count !== undefined && local.join(' ') !== expectedShards(count).join(' ')) {
    problems.push(
      `tests/project.json: the local loop runs ${local.join(' ')} and the matrix of ci.yml has ${count} shards: change them together`
    )
  }

  const waited = needsOf(sources.workflow, SECURITY_AGGREGATOR)
  for (const job of [SECURITY_JOBS[0], ...SECURITY_COMPANION_JOBS]) {
    if (!waited.includes(job)) {
      problems.push(
        `ci.yml ${SECURITY_AGGREGATOR}: must wait for ${job} (needs: ${waited.join(', ') || 'nothing'})`
      )
    }
  }

  const aggregator = jobBlock(sources.workflow, SECURITY_AGGREGATOR) ?? ''
  for (const job of SECURITY_COMPANION_JOBS) {
    if (!aggregator.includes(`needs.${job}.result`)) {
      problems.push(
        `ci.yml ${SECURITY_AGGREGATOR}: must read needs.${job}.result, or a red job reads green`
      )
    }
    const block = jobBlock(sources.workflow, job) ?? ''
    for (const command of ['pnpm test:latency', 'pnpm test:rls-plan']) {
      if (!block.includes(command)) problems.push(`ci.yml ${job}: must run \`${command}\``)
    }
  }

  const slices = matrixOf(sources.workflow, E2E_JOB, 'shard')
  const total = matrixOf(sources.workflow, E2E_JOB, 'total')
  const sliceNumbers = (slices ?? []).map(Number)
  if (
    slices === null ||
    total === null ||
    total.length !== 1 ||
    sliceNumbers.join(' ') !== Array.from({ length: Number(total[0]) }, (_, i) => i + 1).join(' ')
  ) {
    problems.push(
      `ci.yml ${E2E_JOB}: the slices must be 1 to total, each once (shard: ${slices?.join(' ') ?? 'missing'}, total: ${total?.join(' ') ?? 'missing'})`
    )
  }

  if (sources.composeClamav === null || sources.actionClamav === null) {
    problems.push(
      'clamav: the image was not found in docker-compose.yml or in .github/actions/clamav-start'
    )
  } else if (sources.composeClamav !== sources.actionClamav) {
    problems.push(
      `clamav: the image of .github/actions/clamav-start (${sources.actionClamav}) must match docker-compose.yml (${sources.composeClamav}); Dependabot reads only the compose file, so a bump of one is a bump of both`
    )
  }
  return problems
}
