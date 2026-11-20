import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  baselineGrowth,
  checkAgainstBaseline,
  countContextFree,
  isScanned,
  lowerBaseline,
  slackOf
} from './rls-worker-baseline'

describe('countContextFree', () => {
  it('counts the accesses of a file that has no context', () => {
    const source = `
      const a = await this.prisma.client.media.findMany()
      await this.prisma.transaction(tx => tx.x())
      await this.prisma.client.$queryRaw\`SELECT 1\`
    `
    expect(countContextFree(source)).toBe(4)
  })

  it('counts nothing in a file that proves that it sees every row, or that says every access runs in a context', () => {
    expect(
      countContextFree('await assertSeesEveryRow(this.prisma, []); this.prisma.client.a')
    ).toBe(0)
    expect(countContextFree('// rls-context: the caller opens it\nthis.prisma.client.a')).toBe(0)
  })

  it('does not take a marker that is not a comment line of its own', () => {
    expect(countContextFree('const a = 1 // rls-context: x\nthis.prisma.client.a')).toBe(1)
    expect(countContextFree('const s = "rls-context: "\nthis.prisma.client.a')).toBe(1)
  })

  it('still counts a file that only names JobContext', () => {
    expect(
      countContextFree('this.jobContext.forStore(id, () => 1)\nthis.prisma.client.x.find()')
    ).toBe(1)
  })

  it('ignores comments', () => {
    expect(countContextFree('// this.prisma.client.x\n/* prisma.transaction */')).toBe(0)
  })
})

describe('the baseline', () => {
  it('only lets a file go down', () => {
    expect(checkAgainstBaseline({ a: 2 }, { a: 3 })).toEqual([{ file: 'a', allowed: 2, found: 3 }])
    expect(checkAgainstBaseline({ a: 2 }, { a: 2, b: 1 })).toEqual([
      { file: 'b', allowed: 0, found: 1 }
    ])
    expect(checkAgainstBaseline({ a: 2 }, { a: 1 })).toEqual([])
  })

  it('lowers and drops entries, and refuses to lower while a file goes up', () => {
    expect(lowerBaseline({ a: 2, b: 1 }, { a: 1 })).toEqual({ a: 1 })
    expect(() => lowerBaseline({ a: 1 }, { a: 2 })).toThrow('cannot lower')
    expect(slackOf({ a: 2, b: 1 }, { a: 2 })).toEqual(['b'])
  })

  it('finds an entry that rose against main', () => {
    expect(baselineGrowth({ a: 1 }, { a: 2, b: 1 }).sort()).toEqual(['a', 'b'])
    expect(baselineGrowth({ a: 2 }, { a: 1 })).toEqual([])
  })

  it('scans the worker and not its specs', () => {
    expect(isScanned('apps/worker/src/media/x.service.ts')).toBe(true)
    expect(isScanned('apps/worker/src/media/x.service.spec.ts')).toBe(false)
    expect(isScanned('apps/api/src/x.ts')).toBe(false)
  })
})

// Stage E takes BYPASSRLS away from the worker: from then on an access with no context reads no row, so none may be left. The file only
// goes down (`validate:rls-worker --update-down`); this says that it has reached the bottom, and that it stays there
describe('the baseline of the worker after stage E', () => {
  it('is empty: no file of the worker is left with an access that runs with no context', () => {
    const baseline: unknown = JSON.parse(
      readFileSync(join(__dirname, '..', 'rls-worker-baseline.json'), 'utf8')
    )
    expect(baseline).toEqual({})
  })
})
