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

  it('counts nothing in a file that works inside a context or proves that it sees every row', () => {
    expect(
      countContextFree('this.jobContext.forStore(id, () => this.prisma.client.x.find())')
    ).toBe(0)
    expect(
      countContextFree('await assertSeesEveryRow(this.prisma, []); this.prisma.client.a')
    ).toBe(0)
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
