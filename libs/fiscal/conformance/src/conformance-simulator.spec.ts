import { conformanceGaps, ConformanceOutcome, runConformance } from '@platform/fiscal/sdk'
import { simulatorProvider } from '@platform/fiscal/simulator'
import {
  planSvConformance,
  SvConformanceDemoIssuer,
  svConformanceTargets,
  svDryRunCredited
} from '@platform/fiscal/sv'

// The minimum tests of the sandbox run with the simulator, the default of the script: nothing leaves the process, and what the simulator
// cannot do (a contingency) is said and not hidden.

const NOW = new Date('2026-11-17T15:00:00.000Z')
const steps = planSvConformance({
  issuer: SvConformanceDemoIssuer,
  batch: 'sim',
  seed: 5,
  now: NOW
})

describe('the conformance run with the simulator', () => {
  it('makes and sends every document, every credit note and every invalidation of the plan', async () => {
    const report = await runConformance(steps, {
      provider: simulatorProvider(),
      issuer: SvConformanceDemoIssuer,
      credentials: {},
      batch: 'sim',
      dryRun: false,
      dryRunCredited: svDryRunCredited
    })
    const accepted = Object.values(report.documents).reduce(
      (sum, totals) => sum + totals.accepted,
      0
    )
    // 90 + 75 + 8 made for the invalidations + 50 credit notes + 25 debit notes + 50 remission notes; the deferred ones need a contingency mode
    expect(accepted).toBe(90 + 75 + 8 + 50 + 25 + 50)
    // The notes are made as the type the simulator declares for them, and fill the bucket of their own
    expect(report.documents['simulated_remission_note']).toMatchObject({
      planned: 50,
      accepted: 50
    })
    expect(report.minimum['remission_note']).toEqual({ planned: 50, accepted: 50 })
    expect(report.voids).toEqual({ planned: 5, done: 5, refused: 0 })
    expect(Object.values(report.documents).reduce((sum, totals) => sum + totals.rejected, 0)).toBe(
      0
    )
  })

  it('says that the simulator has no contingency mode instead of counting the contingencies as made', async () => {
    const report = await runConformance(steps, {
      provider: simulatorProvider(),
      issuer: SvConformanceDemoIssuer,
      credentials: {},
      batch: 'sim',
      dryRun: false,
      dryRunCredited: svDryRunCredited
    })
    expect(report.contingencies).toMatchObject({ planned: 5, reported: 0, deferred: 0 })
    expect(report.unbuilt).toEqual({ deferred_sale: 10 })
    expect(report.codes).toEqual({ no_contingency_mode: 15 })
    // And the coverage of the authority is not reached: the gap says which
    expect(conformanceGaps(report, svConformanceTargets()).missing['contingencies']).toBe(5)
  })

  it('builds everything and sends nothing in a dry run', async () => {
    const report = await runConformance(steps, {
      provider: simulatorProvider(),
      issuer: SvConformanceDemoIssuer,
      credentials: {},
      batch: 'sim',
      dryRun: true,
      dryRunCredited: svDryRunCredited
    })
    expect(report.steps.filter(step => step.outcome === ConformanceOutcome.ACCEPTED)).toEqual([])
    expect(
      report.steps.filter(step => step.outcome === ConformanceOutcome.DRY_RUN_BUILT)
    ).toHaveLength(90 + 75 + 8 + 50 + 25 + 50)
  })

  it('keeps the data of the issuer and of the receivers out of its report', async () => {
    const report = await runConformance(steps, {
      provider: simulatorProvider(),
      issuer: SvConformanceDemoIssuer,
      credentials: {},
      batch: 'sim',
      dryRun: false,
      secrets: [
        SvConformanceDemoIssuer.taxId,
        SvConformanceDemoIssuer.legalName,
        SvConformanceDemoIssuer.email ?? ''
      ],
      dryRunCredited: svDryRunCredited
    })
    const text = JSON.stringify(report)
    expect(text).not.toContain(SvConformanceDemoIssuer.legalName)
    expect(text).not.toContain('example.test')
    expect(text).not.toMatch(/0000\d{10}/)
  })
})
