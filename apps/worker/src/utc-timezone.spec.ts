import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

// Jest gives a test its own copy of `process.env`, so setting `TZ` inside a test never reaches the real process and a Date
// would not move. The module is run where it matters, in a Node process started in a zone far from UTC (Dubai, UTC+4,
// the zone of the machine that showed the problem). Node 24 loads the .ts file as it is (it has no imports).
const DUBAI = 'Asia/Dubai'
const MODULE = join(__dirname, 'utc-timezone.ts')

// The same expression the finance reconciliation uses (`Schedules.RECONCILE_FINANCE`, documented as 04:30 UTC)
const FINANCE_DAILY = '30 4 * * *'

interface Seen {
  tz: string | undefined
  localDateIso: string
  nextFireUtc: string
}

function inProcessInDubai(loadModule: boolean): Seen {
  const code = `
    ${loadModule ? `require(${JSON.stringify(MODULE)})` : ''}
    const { CronTime } = require('cron')
    console.log(JSON.stringify({
      tz: process.env.TZ,
      localDateIso: new Date(2026, 10, 22, 4, 30).toISOString(),
      nextFireUtc: new CronTime(${JSON.stringify(FINANCE_DAILY)}).sendAt().toUTC().toFormat('HH:mm')
    }))`
  const out = execFileSync(process.execPath, ['--no-warnings', '-e', code], {
    cwd: process.cwd(),
    // Only the zone: the absolute path of Node needs no PATH, and `cron` resolves from the working directory
    env: { TZ: DUBAI },
    encoding: 'utf8'
  })
  return JSON.parse(out) as Seen
}

describe('utc-timezone', () => {
  it('shows the problem: without the module a process in Dubai fires the 04:30 UTC schedule at 00:30 UTC', () => {
    const seen = inProcessInDubai(false)
    expect(seen.tz).toBe(DUBAI)
    expect(seen.localDateIso).toBe('2026-11-22T00:30:00.000Z')
    expect(seen.nextFireUtc).toBe('00:30')
  })

  it('puts the process in UTC: local dates are UTC dates and the schedule fires at its documented hour', () => {
    const seen = inProcessInDubai(true)
    expect(seen.tz).toBe('UTC')
    expect(seen.localDateIso).toBe('2026-11-22T04:30:00.000Z')
    expect(seen.nextFireUtc).toBe('04:30')
  })
})
