import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ConformanceLeakError,
  ConformanceOutcome,
  type ConformanceReport
} from '@platform/fiscal/sdk'
import { SvSandboxConfirmation, SvSandboxEnvNames } from '@platform/fiscal/sv'

import { ConformanceExit, runConformanceCli, signerUrlProblem } from '../tools/conformance-cli'

// The gates of the tool that can send documents to the sandbox of the tax authority: what it refuses, what it prints and what it writes.
// Nothing here sends anything: every case that would send is refused before a provider is made, or runs the simulator.

const SECRETS = {
  api: 'api-password-SECRET-1',
  key: 'key-password-SECRET-2',
  taxId: '0614-010101-101-1'
}
const FULL: Record<string, string> = {
  [SvSandboxEnvNames.CONFIRM]: SvSandboxConfirmation,
  [SvSandboxEnvNames.SIGNER_URL]: 'http://signer.internal:8113',
  [SvSandboxEnvNames.TAX_ID]: SECRETS.taxId,
  [SvSandboxEnvNames.API_PASSWORD]: SECRETS.api,
  [SvSandboxEnvNames.KEY_PASSWORD]: SECRETS.key,
  [SvSandboxEnvNames.LEGAL_NAME]: 'Mi Empresa S.A.',
  [SvSandboxEnvNames.REGISTRATION]: '123456-7',
  [SvSandboxEnvNames.ACTIVITY]: '47119',
  [SvSandboxEnvNames.ESTABLISHMENT_CODE]: 'M001',
  [SvSandboxEnvNames.ESTABLISHMENT_TYPE]: '02',
  [SvSandboxEnvNames.POINT_OF_SALE_CODE]: 'P001',
  [SvSandboxEnvNames.DEPARTMENT]: '06',
  [SvSandboxEnvNames.MUNICIPALITY]: '23',
  [SvSandboxEnvNames.DISTRICT]: '01',
  [SvSandboxEnvNames.COMPLEMENT]: 'Calle 1',
  [SvSandboxEnvNames.PHONE]: '22220000',
  [SvSandboxEnvNames.EMAIL]: 'yo@example.test',
  [SvSandboxEnvNames.RESPONSIBLE_NAME]: 'Ana Pérez',
  [SvSandboxEnvNames.RESPONSIBLE_ID_TYPE]: '13',
  [SvSandboxEnvNames.RESPONSIBLE_ID_NUMBER]: '012345678'
}

function harness() {
  const out: string[] = []
  const err: string[] = []
  const files = new Map<string, string>()
  return {
    out,
    err,
    files,
    io: {
      out: (text: string) => out.push(text),
      err: (text: string) => err.push(text),
      write: (path: string, text: string) => files.set(path, text)
    },
    everything: () => [...out, ...err, ...files.values()].join('')
  }
}

describe('the conformance tool refuses what it does not know', () => {
  it.each([
    ['an option that does not exist (a typo of a safety switch)', ['--dryrun']],
    ['a word that is no option', ['sandbox']],
    ['an option with no value', ['--out']],
    ['an option whose value is another option', ['--out', '--json']],
    ['a provider it does not know', ['--provider', 'other']],
    ['a seed that is not a whole number', ['--seed', '12abc']],
    ['a batch with characters it does not take', ['--batch', 'a b']],
    ['a count it does not know', ['--counts', 'toString=1']],
    ['a count that is not a number', ['--counts', 'invoices=many']],
    ['a count with two equals signs', ['--counts', 'invoices=90=5']],
    ['a value option given twice', ['--provider', 'simulator', '--provider', 'sv']],
    ['a batch given twice', ['--batch', 'b1', '--batch', 'b2']],
    ['a name of the prototype of an object as a count', ['--counts', 'constructor=1']],
    ['a name given twice', ['--counts', 'invoices=9,invoices=10']],
    ['a count a thousand times too big', ['--counts', 'invoices=9999']],
    ['more contingencies than the limit', ['--counts', 'contingencies=21']]
  ])('%s', async (_label, args) => {
    const h = harness()
    expect(await runConformanceCli(args, {}, h.io)).toBe(ConformanceExit.REFUSED)
    expect(h.out).toEqual([])
  })

  it('refuses a dry run too where NODE_ENV is production when the environment of the owner is set', async () => {
    const h = harness()
    expect(
      await runConformanceCli(
        ['--provider', 'sv', '--dry-run'],
        { ...FULL, NODE_ENV: 'production' },
        h.io
      )
    ).toBe(ConformanceExit.REFUSED)
    // With nothing set a dry run is inert and is not refused
    const inert = harness()
    expect(
      await runConformanceCli(
        ['--provider', 'sv', '--dry-run'],
        { NODE_ENV: 'production' },
        inert.io
      )
    ).toBe(ConformanceExit.OK)
  })

  it('refuses a typo of --dry-run with the whole environment set, and sends nothing', async () => {
    const h = harness()
    expect(await runConformanceCli(['--provider', 'sv', '--dryrun'], FULL, h.io)).toBe(
      ConformanceExit.REFUSED
    )
    expect(h.out).toEqual([])
  })
})

describe('the gates of a real send', () => {
  it('refuses with nothing set, and lists the names, never a value', async () => {
    const h = harness()
    expect(await runConformanceCli(['--provider', 'sv'], {}, h.io)).toBe(ConformanceExit.REFUSED)
    const text = h.err.join('')
    expect(text).toContain(SvSandboxEnvNames.API_PASSWORD)
    expect(text).toContain(`${SvSandboxEnvNames.CONFIRM}=${SvSandboxConfirmation}`)
  })

  it('refuses without the confirmation of the owner, whatever else is set, and prints no value', async () => {
    const rest = Object.fromEntries(
      Object.entries(FULL).filter(([name]) => name !== SvSandboxEnvNames.CONFIRM)
    )
    const h = harness()
    expect(await runConformanceCli(['--provider', 'sv'], rest, h.io)).toBe(ConformanceExit.REFUSED)
    for (const secret of Object.values(SECRETS)) expect(h.everything()).not.toContain(secret)
  })

  it('refuses where NODE_ENV is production, with everything set and confirmed', async () => {
    const h = harness()
    expect(
      await runConformanceCli(['--provider', 'sv'], { ...FULL, NODE_ENV: 'production' }, h.io)
    ).toBe(ConformanceExit.REFUSED)
    expect(h.err.join('')).toContain('NODE_ENV')
  })

  it('refuses a signing service on a public host over http, and one with a user in its address, before a provider is made', async () => {
    for (const url of [
      'http://signer.example.com:8113',
      'http://user:pw@signer.internal:8113',
      'ftp://signer',
      'not a url'
    ]) {
      const h = harness()
      const code = await runConformanceCli(
        ['--provider', 'sv'],
        { ...FULL, [SvSandboxEnvNames.SIGNER_URL]: url },
        h.io
      )
      expect(code).toBe(ConformanceExit.REFUSED)
      expect(h.everything()).not.toContain('pw')
      expect(h.everything()).not.toContain(url)
    }
  })

  it('knows a private signing service from a public one', () => {
    for (const ok of [
      'http://signer:8113',
      'http://127.0.0.1:8113',
      'http://localhost:8113',
      'http://10.0.0.5:8113',
      'http://192.168.1.7:8113',
      'http://172.20.0.3:8113',
      'http://signer.internal:8113',
      'https://signer.example.com'
    ]) {
      expect(signerUrlProblem(ok)).toBeNull()
    }
    for (const bad of [
      'http://signer.example.com',
      'http://8.8.8.8:8113',
      'http://172.32.0.1',
      // Names that only begin like a private address, and addresses of the public internet written in IPv6
      'http://10.attacker.com',
      'http://127.evil.net',
      'http://192.168.evil.org',
      'http://[2001:4860:4860::8888]:8113'
    ]) {
      expect(signerUrlProblem(bad)).not.toBeNull()
    }
    expect(signerUrlProblem('http://[::1]:8113')).toBeNull()
    expect(signerUrlProblem('http://[fd00::1]:8113')).toBeNull()
  })
})

describe('what the tool runs and prints', () => {
  it('prints the names it reads with --help-env, and no value', async () => {
    const h = harness()
    expect(await runConformanceCli(['--help-env'], FULL, h.io)).toBe(ConformanceExit.OK)
    expect(h.out.join('')).toContain(SvSandboxEnvNames.KEY_PASSWORD)
    for (const secret of Object.values(SECRETS)) expect(h.everything()).not.toContain(secret)
  })

  it('makes a dry run of the plan of the provider with no environment, sending nothing', async () => {
    const h = harness()
    const code = await runConformanceCli(['--provider', 'sv', '--dry-run'], {}, h.io)
    expect(code).toBe(ConformanceExit.OK)
    expect(h.out.join('')).toContain('dry run: nothing was sent')
    expect(h.out.join('')).toContain(
      'minimum (accepted of planned): invoice 0/90, tax_credit 0/75, credit_note 0/50'
    )
    // The number to start the next run from: the series of the invoices holds the minimum and the documents made for the other tests
    expect(h.out.join('')).toMatch(/next --offset: 1\d\d /)
  })

  it('runs through the simulator by default, and writes a report with no document, no number and no secret', async () => {
    const h = harness()
    const code = await runConformanceCli(
      [
        '--out',
        'report.json',
        '--counts',
        'invoices=5,taxCredits=4,creditNotes=2,voids=1,contingencies=1'
      ],
      {},
      h.io
    )
    expect(code).toBe(ConformanceExit.OK)
    const report = h.files.get('report.json') ?? ''
    expect(JSON.parse(report)).toHaveProperty('steps')
    expect(report).not.toMatch(/[A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12}/)
    expect(report).not.toContain('example.test')
    expect(h.out.join('')).toContain('not counted for this provider')
  })

  it('writes the report where it is told in a real folder too', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'conformance-'))
    try {
      const { writeFileSync } = await import('node:fs')
      const h = harness()
      const path = join(dir, 'r.json')
      await runConformanceCli(
        [
          '--counts',
          'invoices=2,taxCredits=1,creditNotes=1,voids=0,contingencies=0',
          '--out',
          path
        ],
        {},
        {
          ...h.io,
          write: (target, text) => writeFileSync(target, text)
        }
      )
      expect(JSON.parse(readFileSync(path, 'utf8'))).toHaveProperty('minimum')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

const reportOf = (over: Partial<ConformanceReport> = {}): ConformanceReport => ({
  mode: 'live',
  batch: 'b1',
  documents: {},
  unbuilt: {},
  minimum: {
    invoice: { planned: 90, accepted: 90 },
    tax_credit: { planned: 75, accepted: 75 },
    credit_note: { planned: 50, accepted: 50 }
  },
  voids: { planned: 5, done: 5, refused: 0 },
  contingencies: { planned: 5, reported: 5, refused: 0, deferred: 10, deferredAccepted: 10 },
  tags: {},
  codes: {},
  steps: [],
  ...over
})

describe('the exit codes of a run, with a runner that sends nothing', () => {
  const live = ['--provider', 'sv']

  it('exits 0 when a real run reaches the minimum, and says so', async () => {
    const h = harness()
    const code = await runConformanceCli(live, FULL, h.io, {
      runner: () => Promise.resolve(reportOf())
    })
    expect(code).toBe(ConformanceExit.OK)
    expect(h.out.join('')).toContain('the minimum is reached')
  })

  it('exits 1 when a real run falls short, and says what is missing', async () => {
    const h = harness()
    const short = reportOf({
      minimum: {
        invoice: { planned: 90, accepted: 80 },
        tax_credit: { planned: 75, accepted: 75 },
        credit_note: { planned: 50, accepted: 50 }
      }
    })
    const code = await runConformanceCli(live, FULL, h.io, { runner: () => Promise.resolve(short) })
    expect(code).toBe(ConformanceExit.INCOMPLETE)
    expect(h.out.join('')).toContain('still missing invoice 10')
  })

  it('exits 1 when the minimum is reached but something else failed', async () => {
    const h = harness()
    const broken = reportOf({
      steps: [
        {
          id: 'VOID-1',
          kind: 'void',
          documentType: null,
          outcome: ConformanceOutcome.VOID_REFUSED,
          code: '053'
        }
      ]
    })
    const code = await runConformanceCli(live, FULL, h.io, {
      runner: () => Promise.resolve(broken)
    })
    expect(code).toBe(ConformanceExit.INCOMPLETE)
  })

  it('judges a reduced run against the minimum of the authority, not against what was asked of it', async () => {
    const h = harness()
    const reduced = reportOf({
      minimum: {
        invoice: { planned: 1, accepted: 1 },
        tax_credit: { planned: 1, accepted: 1 },
        credit_note: { planned: 1, accepted: 1 }
      },
      voids: { planned: 0, done: 0, refused: 0 },
      contingencies: { planned: 0, reported: 0, refused: 0, deferred: 0, deferredAccepted: 0 }
    })
    const code = await runConformanceCli(
      [...live, '--counts', 'invoices=1,taxCredits=1,creditNotes=1,voids=0,contingencies=0'],
      FULL,
      h.io,
      { runner: () => Promise.resolve(reduced) }
    )
    expect(code).toBe(ConformanceExit.INCOMPLETE)
    expect(h.out.join('')).not.toContain('the minimum is reached')
  })

  it('withholds the report and prints only numbers when a secret was found in it', async () => {
    const h = harness()
    const code = await runConformanceCli(live, FULL, h.io, {
      runner: () =>
        Promise.reject(
          new ConformanceLeakError({
            steps: 10,
            accepted: 7,
            refused: 1,
            unavailable: 2,
            voided: 0,
            contingenciesReported: 0
          })
        )
    })
    expect(code).toBe(ConformanceExit.LEAK)
    expect(h.err.join('')).toContain('"accepted":7')
    for (const secret of Object.values(SECRETS)) expect(h.everything()).not.toContain(secret)
    expect(h.out).toEqual([])
  })

  it('prints only the name of an error that breaks the run, never its message', async () => {
    const h = harness()
    const code = await runConformanceCli(live, FULL, h.io, {
      runner: () => Promise.reject(new TypeError(`bad ${SECRETS.api} ${SECRETS.taxId}`))
    })
    expect(code).toBe(ConformanceExit.FAILED)
    expect(h.err.join('')).toContain('TypeError')
    for (const secret of Object.values(SECRETS)) expect(h.everything()).not.toContain(secret)
  })

  it('makes a dry run with the whole environment set without sending: the real signer is only made, never called', async () => {
    const h = harness()
    const report = reportOf({ mode: 'dry_run', steps: [] })
    const code = await runConformanceCli([...live, '--dry-run'], FULL, h.io, {
      runner: () => Promise.resolve(report)
    })
    expect(code).toBe(ConformanceExit.OK)
    expect(h.out.join('')).toContain('dry run: nothing was sent')
  })
})
