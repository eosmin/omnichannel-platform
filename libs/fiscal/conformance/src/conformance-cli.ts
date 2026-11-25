import { isIP } from 'node:net'

import {
  type ConformanceReport,
  ConformanceCodes,
  ConformanceLeakError,
  ConformanceOutcome,
  conformanceGaps,
  type FiscalDocumentProvider,
  type FiscalIssuerInput,
  runConformance
} from '@platform/fiscal/sdk'
import { simulatorProvider } from '@platform/fiscal/simulator'
import {
  officialSigner,
  planSvConformance,
  readSvSandboxEnv,
  SvConformanceDemoIssuer,
  svConformanceTargets,
  svMonthJustStarted,
  svNextOffset,
  svDryRunCredited,
  svProvider,
  SvSandboxConfirmation,
  SvSandboxEnvNames,
  type SvConformanceCounts
} from '@platform/fiscal/sv'

// The logic of the conformance run, apart from the process (its arguments, its environment and its outputs come in as parameters), so that
// the gates that keep a real send from happening by accident are tested. The entry point is `run-conformance.ts`.

export interface ConformanceCliIo {
  out(text: string): void
  err(text: string): void
  write(path: string, text: string): void
}

// What the process exits with
export const ConformanceExit = {
  OK: 0,
  // The run was made and did not reach what it was asked
  INCOMPLETE: 1,
  // What was asked is not something the tool does (an option, a missing name, a refusal of a gate): nothing was sent
  REFUSED: 2,
  // A secret was found in the report: it is withheld; the numbers of what was done are printed
  LEAK: 3,
  // An error of the run itself: only its name is printed
  FAILED: 4
} as const

// The most each count may be asked for: more than the minimum, by a margin, and never a mistake of a thousand times
const CountLimits: Readonly<Record<keyof SvConformanceCounts, number>> = {
  invoices: 500,
  taxCredits: 500,
  creditNotes: 500,
  debitNotes: 500,
  voids: 20,
  contingencies: 20,
  deferredPerContingency: 50
}

const BOOLEAN_OPTIONS = new Set(['--dry-run', '--json', '--help-env'])
const VALUE_OPTIONS = new Set(['--provider', '--seed', '--batch', '--offset', '--counts', '--out'])
const WHOLE = /^\d{1,9}$/
const BATCH = /^[A-Za-z0-9_-]{1,20}$/

interface Parsed {
  flags: Set<string>
  values: Map<string, string>
}

// Strict: an option the tool does not know, a value that is missing and a word that is no option are refused, because a typo in a safety
// switch (`--dryrun`) must never read as "no switch"
function parse(args: readonly string[]): Parsed | string {
  const flags = new Set<string>()
  const values = new Map<string, string>()
  for (let at = 0; at < args.length; at += 1) {
    const token = args[at] ?? ''
    if (BOOLEAN_OPTIONS.has(token)) {
      flags.add(token)
    } else if (VALUE_OPTIONS.has(token)) {
      const value = args[at + 1]
      if (value === undefined || value.startsWith('--')) return `${token} needs a value`
      // Given twice it would be the last that counts, silently: a real send assembled from a shell alias and extra arguments could change
      // the provider or the batch without anyone noticing
      if (values.has(token)) return `${token} is given twice`
      values.set(token, value)
      at += 1
    } else {
      return 'unknown option'
    }
  }
  return { flags, values }
}

// Where the signing service may be: the key password goes to it in clear text, so it is on this machine or on a private network, or it is
// reached over https. A host that is public, and not https, is refused.
export function signerUrlProblem(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return 'the address of the signing service is not a URL'
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'the address of the signing service is http or https'
  }
  if (url.username !== '' || url.password !== '') {
    return 'the address of the signing service carries no user or password'
  }
  if (url.protocol === 'https:') return null
  return isPrivateHost(url.hostname)
    ? null
    : 'the signing service over http must be on this machine or a private network'
}

// An address is private when it IS one (an IP literal in a private range) or when it is a name of a private network: one label (the name of a
// service of a network of containers), `localhost` or a suffix kept for private use. A name with dots that merely begins like an address
// (`10.example.com`) is a public name.
function isPrivateHost(rawHost: string): boolean {
  const host = rawHost.replace(/^\[|\]$/g, '').toLowerCase()
  const kind = isIP(host)
  if (kind === 4) {
    const [a, b] = host.split('.').map(Number)
    return (
      a === 127 ||
      a === 10 ||
      (a === 192 && b === 168) ||
      (a === 172 && b !== undefined && b >= 16 && b <= 31)
    )
  }
  if (kind === 6) return host === '::1' || /^f[cd][0-9a-f]{2}:/.test(host)
  if (host === 'localhost') return true
  return !host.includes('.') || /\.(internal|local|lan|localhost)$/.test(host)
}

export interface ConformanceCliOptions {
  // For the tests of the gates and the exit codes: what runs the plan (nothing is sent by a test that gives its own)
  readonly runner?: typeof runConformance
}

export async function runConformanceCli(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  io: ConformanceCliIo,
  options: ConformanceCliOptions = {}
): Promise<number> {
  try {
    return await run(args, env, io, options.runner ?? runConformance)
  } catch (error) {
    if (error instanceof ConformanceLeakError) {
      // Numbers only: what was sent, so that it is not sent again
      io.err(
        `A value that must stay secret was found in the report: it is withheld. Done: ${JSON.stringify(error.counts)}\n`
      )
      return ConformanceExit.LEAK
    }
    // Only the name of the error: its message or its fields may carry what was read from the environment
    io.err(
      `The run stopped with an error (${error instanceof Error ? error.name : 'unknown'}); no details are printed.\n`
    )
    return ConformanceExit.FAILED
  }
}

async function run(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  io: ConformanceCliIo,
  runner: typeof runConformance
): Promise<number> {
  const parsed = parse(args)
  if (typeof parsed === 'string') {
    io.err(`${parsed}\n`)
    return ConformanceExit.REFUSED
  }
  const { flags, values } = parsed
  if (flags.has('--help-env')) {
    io.out(
      `Names read for the real sandbox (the values are never printed):\n${Object.values(
        SvSandboxEnvNames
      )
        .map(name => `  ${name}`)
        .join('\n')}\nand ${SvSandboxEnvNames.CONFIRM}=${SvSandboxConfirmation} to send.\n`
    )
    return ConformanceExit.OK
  }

  const providerName = values.get('--provider') ?? 'simulator'
  const dryRun = flags.has('--dry-run')
  const seedText = values.get('--seed') ?? '2026'
  const offsetText = values.get('--offset') ?? '0'
  const batch = values.get('--batch') ?? 'b1'
  if (!['simulator', 'sv'].includes(providerName)) {
    io.err('--provider is simulator or sv\n')
    return ConformanceExit.REFUSED
  }
  if (!WHOLE.test(seedText) || !WHOLE.test(offsetText)) {
    io.err('--seed and --offset are whole numbers\n')
    return ConformanceExit.REFUSED
  }
  if (!BATCH.test(batch)) {
    io.err('--batch is up to 20 letters, digits, - or _\n')
    return ConformanceExit.REFUSED
  }
  const counts: Partial<Record<keyof SvConformanceCounts, number>> = {}
  for (const part of (values.get('--counts') ?? '').split(',').filter(piece => piece !== '')) {
    // Exactly name=number, a name once, and a number that is not a mistake of a thousand times (a real run sends every document)
    const found = /^([A-Za-z]+)=(\d{1,4})$/.exec(part)
    const name = found?.[1]
    const bound =
      name === undefined || !Object.hasOwn(CountLimits, name)
        ? undefined
        : CountLimits[name as keyof SvConformanceCounts]
    if (
      found === null ||
      name === undefined ||
      bound === undefined ||
      Object.hasOwn(counts, name) ||
      Number.parseInt(found[2] ?? '', 10) > bound
    ) {
      io.err(
        `--counts is name=number, each name once, from ${Object.entries(CountLimits)
          .map(([key, limit]) => `${key} (up to ${limit})`)
          .join(', ')}\n`
      )
      return ConformanceExit.REFUSED
    }
    counts[name as keyof SvConformanceCounts] = Number.parseInt(found[2] ?? '', 10)
  }

  let provider: FiscalDocumentProvider
  let issuer: FiscalIssuerInput = SvConformanceDemoIssuer
  let credentials: Record<string, unknown> = {}
  let secrets: readonly string[] = []
  let responsible: { name: string; idType: string; idNumber: string } | undefined

  if (providerName === 'simulator') {
    provider = simulatorProvider()
  } else {
    const reading = readSvSandboxEnv(env)
    // The gates of a real send, in the order they are asked; every one of them refuses before anything is built. Production is refused for
    // anything that would use the environment of the owner, a dry run with it set included.
    if (env['NODE_ENV'] === 'production' && (!dryRun || reading.ready)) {
      io.err('this does not run where NODE_ENV is production\n')
      return ConformanceExit.REFUSED
    }
    if (!dryRun) {
      if (svMonthJustStarted(new Date())) {
        io.err(
          'this does not run in the first minutes of a month (the documents are dated inside the month of the run)\n'
        )
        return ConformanceExit.REFUSED
      }
      if (!reading.ready) {
        io.err(
          `The real sandbox needs these names set${reading.confirmed ? '' : ` and ${SvSandboxEnvNames.CONFIRM}=${SvSandboxConfirmation}`}:\n${reading.missing.map(name => `  ${name}`).join('\n')}\n`
        )
        return ConformanceExit.REFUSED
      }
    }
    if (reading.ready) {
      const problem = signerUrlProblem(reading.setup.signerUrl)
      if (problem !== null) {
        io.err(`${problem}\n`)
        return ConformanceExit.REFUSED
      }
      // Only the sandbox of the owner: what is read here never goes to a file or a line of output
      issuer = reading.setup.issuer
      credentials = { ...reading.setup.credentials }
      secrets = reading.setup.secrets
      responsible = reading.setup.responsible
      provider = svProvider({
        signer: officialSigner({
          baseUrl: reading.setup.signerUrl,
          fetch: (url, init) => fetch(url, init),
          timeoutMs: 20_000
        })
      })
    } else {
      // A dry run with no environment: it builds with an invented issuer and never reaches the signing service
      provider = svProvider({
        signer: { sign: () => Promise.resolve({ kind: 'unavailable' as const }) }
      })
    }
  }

  const steps = planSvConformance({
    issuer,
    batch,
    seed: Number.parseInt(seedText, 10),
    now: new Date(),
    counts,
    correlativeOffset: Number.parseInt(offsetText, 10),
    ...(responsible === undefined ? {} : { responsible })
  })
  const report: ConformanceReport = await runner(steps, {
    provider,
    issuer,
    credentials,
    batch,
    dryRun,
    secrets,
    dryRunCredited: svDryRunCredited
  })

  // The minimum is counted by the buckets of the plan of the provider the targets are for; another provider has types of its own
  const gaps =
    providerName === 'sv'
      ? // Against what the authority asks, not against what was asked of this run: a reduced run is never "the minimum"
        conformanceGaps(report, svConformanceTargets())
      : { ok: true, missing: {} as Record<string, number> }
  io.out(`${summary(report, providerName, dryRun, gaps, svNextOffset(steps))}\n`)
  const out = values.get('--out')
  if (out !== undefined) io.write(out, `${JSON.stringify(report, null, 2)}\n`)
  if (flags.has('--json')) io.out(`${JSON.stringify(report, null, 2)}\n`)

  const failed = report.steps.filter(step => FAILURES.includes(step.outcome)).length
  const brokenSkips = report.steps.filter(
    step =>
      step.outcome === ConformanceOutcome.SKIPPED &&
      step.code !== ConformanceCodes.NO_CONTINGENCY_MODE &&
      step.code !== ConformanceCodes.DRY_RUN
  ).length
  const clean = failed === 0 && brokenSkips === 0
  if (dryRun) return clean ? ConformanceExit.OK : ConformanceExit.INCOMPLETE
  // The minimum reached is not enough for a real run if something else failed (a replacement, a deferred document, an invalidation): the
  // exit code says so for whoever reads it
  if (providerName === 'sv') {
    return gaps.ok && clean ? ConformanceExit.OK : ConformanceExit.INCOMPLETE
  }
  return clean ? ConformanceExit.OK : ConformanceExit.INCOMPLETE
}

const FAILURES: readonly ConformanceOutcome[] = [
  ConformanceOutcome.REJECTED,
  ConformanceOutcome.UNAVAILABLE,
  ConformanceOutcome.NOT_SENT,
  ConformanceOutcome.BUILD_FAILED,
  ConformanceOutcome.ERROR,
  ConformanceOutcome.VOID_REFUSED,
  ConformanceOutcome.REPORT_REFUSED,
  ConformanceOutcome.DEFER_REFUSED
]

function summary(
  report: ConformanceReport,
  providerName: string,
  dryRun: boolean,
  gaps: { ok: boolean; missing: Record<string, number> },
  nextOffset: number
): string {
  const lines: string[] = []
  lines.push(
    `conformance run: provider=${providerName} mode=${report.mode} batch=${report.batch} steps=${report.steps.length}`
  )
  for (const [type, totals] of Object.entries(report.documents)) {
    lines.push(
      `  document ${type}: planned ${totals.planned}, built ${totals.built}, accepted ${totals.accepted}, rejected ${totals.rejected}, unavailable ${totals.unavailable}, not sent ${totals.notSent}`
    )
  }
  lines.push(
    `  minimum (accepted of planned): ${Object.entries(report.minimum)
      .map(([bucket, part]) => `${bucket} ${part.accepted}/${part.planned}`)
      .join(', ')}`,
    `  invalidations: planned ${report.voids.planned}, done ${report.voids.done}, refused ${report.voids.refused}`,
    `  contingencies: planned ${report.contingencies.planned}, reported ${report.contingencies.reported}, refused ${report.contingencies.refused}, documents deferred ${report.contingencies.deferred}, accepted after the event ${report.contingencies.deferredAccepted}`
  )
  const unbuilt = Object.entries(report.unbuilt)
  if (unbuilt.length > 0) {
    lines.push(`  not built: ${unbuilt.map(([kind, n]) => `${kind} ${n}`).join(', ')}`)
  }
  const codes = Object.entries(report.codes).sort((a, b) => b[1] - a[1])
  if (codes.length > 0)
    lines.push(`  codes: ${codes.map(([code, n]) => `${code} x${n}`).join(', ')}`)
  lines.push(
    `  variety: ${Object.entries(report.tags)
      .sort()
      .map(([tag, entry]) => `${tag} ${entry.succeeded}/${entry.planned}`)
      .join(', ')}`
  )
  lines.push(
    dryRun
      ? '  dry run: nothing was sent'
      : providerName !== 'sv'
        ? '  coverage: not counted for this provider (its document types are its own)'
        : gaps.ok
          ? '  coverage: the minimum is reached'
          : `  coverage: still missing ${Object.entries(gaps.missing)
              .map(([what, n]) => `${what} ${n}`)
              .join(', ')}`
  )
  lines.push(
    `  next --offset: ${nextOffset} (the first number a following run of this plan may use is the one after it)`
  )
  return lines.join('\n')
}
