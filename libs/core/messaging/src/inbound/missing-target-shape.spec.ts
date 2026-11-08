import {
  missingTargetShape,
  missingTargetShapeOrNull,
  type TargetCount
} from './missing-target-shape'

const NOW = new Date('2026-11-08T12:00:00.000Z')

describe('missingTargetShape', () => {
  const stored = ['wamid.HBgLAAA1', 'wamid.HBgLAAA2', 'wamid.HBgMBBB3']
  // A thread with those ids and two customer messages in the last two minutes
  const count: TargetCount = filter =>
    Promise.resolve(
      stored.filter(
        id =>
          (filter.startsWith === undefined || id.startsWith(filter.startsWith)) &&
          (filter.since === undefined ? true : id.endsWith('1') || id.endsWith('2'))
      ).length
    )

  it('describes the shape of the id, never the id', async () => {
    const shape = await missingTargetShape({ targetId: 'wamid.HBgLAAA9', count, now: NOW })
    expect(shape).toEqual({
      length: 14,
      prefix: 'wam',
      sameShortPrefix: 3,
      sameLongPrefix: 2,
      recentCustomerMessages: 2
    })
    expect(JSON.stringify(shape)).not.toContain('HBgLAAA9')
  })

  it('counts a prefix of any characters but only names a plain one', async () => {
    const starts: (string | undefined)[] = []
    const spy: TargetCount = filter => {
      starts.push(filter.startsWith)
      return Promise.resolve(0)
    }
    const shape = await missingTargetShape({ targetId: '+/<b>-an-id', count: spy, now: NOW })
    expect(shape.prefix).toBe('?')
    expect(starts).toEqual(expect.arrayContaining(['+/<', '+/<b>-an-i']))
  })

  it('is no shape, and not a failure, when a count throws', async () => {
    const broken: TargetCount = () => Promise.reject(new Error('lock timeout'))
    await expect(
      missingTargetShapeOrNull({ targetId: 'm_abcdef', count: broken, now: NOW })
    ).resolves.toBeNull()
  })

  it('looks two minutes back', async () => {
    const seen: Date[] = []
    const spy: TargetCount = filter => {
      if (filter.since) seen.push(filter.since)
      return Promise.resolve(0)
    }
    await missingTargetShape({ targetId: 'm_abcdef', count: spy, now: NOW })
    expect(seen).toEqual([new Date(NOW.getTime() - 2 * 60 * 1000)])
  })
})
