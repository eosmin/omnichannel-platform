import { organizationDay } from './finance.support'

const clientOf = (timezones: string[]): Parameters<typeof organizationDay>[0] =>
  ({
    store: { findMany: () => Promise.resolve(timezones.map(timezone => ({ timezone }))) }
  }) as unknown as Parameters<typeof organizationDay>[0]

describe('organizationDay', () => {
  // 2026-10-01 02:00Z: already October 1st in UTC and in Auckland, still September 30th in El Salvador (UTC-6)
  const instant = new Date('2026-10-01T02:00:00Z')

  it('is the day of the store that is furthest behind', async () => {
    const day = await organizationDay(
      clientOf(['Pacific/Auckland', 'America/El_Salvador']),
      'org',
      instant
    )

    expect(day).toBe('2026-09-30')
  })

  it('is the day of the only store', async () => {
    expect(await organizationDay(clientOf(['Pacific/Auckland']), 'org', instant)).toBe('2026-10-01')
  })

  it('is the UTC day when the organization has no store', async () => {
    expect(await organizationDay(clientOf([]), 'org', instant)).toBe('2026-10-01')
  })
})
