// The minimum tests the tax authority of El Salvador asks of an issuer before it authorizes it (Step 4B.7c-6): 90 invoices, 75 tax credit
// documents and 50 credit notes with seal, 5 invalidations and 5 contingencies, made of invented data in many shapes.
//
// It runs the plan through the port of a provider and never through the lifecycle of the platform, so it needs no database. By default the
// provider is the simulator and nothing leaves the machine. Against the real sandbox it runs only on the machine of the owner, only with
// the environment below set AND the confirmation given, and it never prints, logs or saves a credential, a token, a password, a tax number
// or a signed document: the report carries the ids of the plan, the kinds, the outcomes and the codes, and it is checked against the secrets
// before it is shown.
//
// Usage:
//   pnpm fiscal:conformance [--provider simulator|sv] [--dry-run] [--seed 2026] [--batch b1]
//        [--offset 0] [--counts invoices=90,taxCredits=75,creditNotes=50,voids=5,contingencies=5,deferredPerContingency=2]
//        [--out report.json] [--json]
//
//   --provider simulator   (default) the simulator: documents, credit notes and invalidations; it has no contingency mode, so those are skipped
//   --provider sv --dry-run  builds every document with the rules of the provider and sends nothing (no environment needed)
//   --provider sv          the real sandbox: needs the names listed by `--help-env` and DTE_SANDBOX_CONFIRM=send-to-sandbox
//   --offset N             the numbers of the series start after N (a second run continues where the first stopped)
//   --batch NAME           a second run with another name is not a duplicate of the first
import { writeFileSync } from 'node:fs'
import { argv, env, exit, stderr, stdout } from 'node:process'

import {
  type ConformanceReport,
  type FiscalDocumentProvider,
  type FiscalIssuerInput,
  conformanceGaps,
  ConformanceCodes,
  ConformanceOutcome,
  runConformance
} from '@platform/fiscal/sdk'
import { simulatorProvider } from '@platform/fiscal/simulator'
import {
  officialSigner,
  planSvConformance,
  readSvSandboxEnv,
  SvConformanceDefaults,
  SvConformanceDemoIssuer,
  svConformanceTargets,
  svDryRunCredited,
  svProvider,
  SvSandboxConfirmation,
  SvSandboxEnvNames,
  type SvConformanceCounts
} from '@platform/fiscal/sv'

const args = argv.slice(2)
const flag = (name: string): boolean => args.includes(name)
const option = (name: string): string | undefined => {
  const at = args.indexOf(name)
  return at === -1 ? undefined : args[at + 1]
}
const fail = (message: string): never => {
  stderr.write(`${message}\n`)
  return exit(2)
}

if (flag('--help-env')) {
  stdout.write(
    `Names read for the real sandbox (the values are never printed):\n${Object.values(
      SvSandboxEnvNames
    )
      .map(name => `  ${name}`)
      .join('\n')}\nand ${SvSandboxEnvNames.CONFIRM}=${SvSandboxConfirmation} to send.\n`
  )
  exit(0)
}

const providerName = option('--provider') ?? 'simulator'
const dryRun = flag('--dry-run')
const seed = Number.parseInt(option('--seed') ?? '2026', 10)
const batch = option('--batch') ?? 'b1'
const offset = Number.parseInt(option('--offset') ?? '0', 10)
if (!['simulator', 'sv'].includes(providerName)) fail('--provider is simulator or sv')
if (!Number.isInteger(seed) || !Number.isInteger(offset) || offset < 0) {
  fail('--seed and --offset are whole numbers')
}
if (!/^[A-Za-z0-9_-]{1,20}$/.test(batch)) fail('--batch is up to 20 letters, digits, - or _')

const counts: Partial<Record<keyof SvConformanceCounts, number>> = {}
for (const part of (option('--counts') ?? '').split(',').filter(piece => piece !== '')) {
  const [name, raw] = part.split('=')
  const value = Number.parseInt(raw ?? '', 10)
  if (
    name === undefined ||
    !(name in SvConformanceDefaults) ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    fail(`--counts names ${Object.keys(SvConformanceDefaults).join(', ')} with whole numbers`)
  }
  counts[name as keyof SvConformanceCounts] = value
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
  if (!dryRun) {
    if (env['NODE_ENV'] === 'production') fail('this does not run where NODE_ENV is production')
    if (!reading.ready) {
      stderr.write(
        `The real sandbox needs these names set${reading.confirmed ? '' : ` and ${SvSandboxEnvNames.CONFIRM}=${SvSandboxConfirmation}`}:\n` +
          `${reading.missing.map(name => `  ${name}`).join('\n')}\n`
      )
      exit(2)
    }
  }
  if (reading.ready) {
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
      signer: {
        sign: () => Promise.resolve({ kind: 'unavailable' as const })
      }
    })
  }
}

const steps = planSvConformance({
  issuer,
  batch,
  seed,
  now: new Date(),
  counts,
  correlativeOffset: offset,
  ...(responsible === undefined ? {} : { responsible })
})

const report: ConformanceReport = await runConformance(steps, {
  provider,
  issuer,
  credentials,
  batch,
  dryRun,
  secrets,
  dryRunCredited: svDryRunCredited
})

// The minimum is counted by the ids of the document types of the provider the targets are for; another provider has types of its own
const gaps =
  providerName === 'sv'
    ? conformanceGaps(report, svConformanceTargets(counts))
    : { ok: true, missing: {} as Record<string, number> }

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
  `  invalidations: planned ${report.voids.planned}, done ${report.voids.done}, refused ${report.voids.refused}`,
  `  contingencies: planned ${report.contingencies.planned}, reported ${report.contingencies.reported}, refused ${report.contingencies.refused}, documents deferred ${report.contingencies.deferred}, accepted after the event ${report.contingencies.deferredAccepted}`
)
const unbuilt = Object.entries(report.unbuilt)
if (unbuilt.length > 0)
  lines.push(`  not built: ${unbuilt.map(([kind, n]) => `${kind} ${n}`).join(', ')}`)
const codes = Object.entries(report.codes).sort((a, b) => b[1] - a[1])
if (codes.length > 0) lines.push(`  codes: ${codes.map(([code, n]) => `${code} x${n}`).join(', ')}`)
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
stdout.write(`${lines.join('\n')}\n`)

const out = option('--out')
if (out !== undefined) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)
if (flag('--json')) stdout.write(`${JSON.stringify(report, null, 2)}\n`)

// What failed: a step that was refused, not answered or broken. A step skipped because the provider has no contingency mode is not a failure.
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
const failed = report.steps.filter(step => FAILURES.includes(step.outcome)).length
const skippedForReal = report.steps.filter(
  step =>
    step.outcome === ConformanceOutcome.SKIPPED &&
    step.code !== ConformanceCodes.NO_CONTINGENCY_MODE &&
    step.code !== ConformanceCodes.DRY_RUN
).length
exit(
  dryRun
    ? failed === 0 && skippedForReal === 0
      ? 0
      : 1
    : providerName === 'sv'
      ? gaps.ok
        ? 0
        : 1
      : failed === 0 && skippedForReal === 0
        ? 0
        : 1
)
