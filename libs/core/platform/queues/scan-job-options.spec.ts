import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { JobNames } from './queue-names'
import { ScanFileRetry, scanFileJobOptions } from './scan-job-options'

const MINUTE_MS = 60_000

// The delay before try n+1 of an exponential backoff, as BullMQ computes it: delay * 2^(tries made - 1)
const waitedInAll = (): number => {
  let total = 0
  for (let made = 1; made < ScanFileRetry.ATTEMPTS; made++) {
    total += ScanFileRetry.BACKOFF_MS * 2 ** (made - 1)
  }
  return total
}

describe('scanFileJobOptions', () => {
  it('names one job per file, so asking twice never makes two', () => {
    expect(scanFileJobOptions('abc').jobId).toBe(`${JobNames.SCAN_FILE}-abc`)
  })

  it('tries 8 times, doubling from 5 seconds', () => {
    expect(scanFileJobOptions('abc')).toMatchObject({
      attempts: 8,
      backoff: { type: 'exponential', delay: 5000 }
    })
  })

  it('waits for the antivirus longer than a restart of it (5 minutes), and not for hours', () => {
    expect(waitedInAll()).toBeGreaterThan(5 * MINUTE_MS)
    expect(waitedInAll()).toBeLessThan(30 * MINUTE_MS)
  })
})

// A producer that adds the job with only its id would bring back the loss of a file to a scanner that blinks (two tries, ten seconds)
describe('every producer of a scan job', () => {
  const root = resolve(__dirname, '../../../..')
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap(name => {
      const path = join(dir, name)
      if (name === 'node_modules' || name === 'dist') return []
      if (statSync(path).isDirectory()) return sources(path)
      return /\.ts$/.test(name) && !/\.spec\.ts$/.test(name) ? [path] : []
    })

  it('takes its options from scanFileJobOptions', () => {
    const offenders = [join(root, 'apps'), join(root, 'libs')]
      .flatMap(sources)
      .filter(path => {
        const text = readFileSync(path, 'utf8')
        return /add\(\s*JobNames\.SCAN_FILE/.test(text) && !text.includes('scanFileJobOptions(')
          ? !path.endsWith('scan-job-options.ts')
          : false
      })
    expect(offenders.map(path => path.replace(root, ''))).toEqual([])
  })
})
