import { CountStatus } from '@platform/core/domain'

import type { CountDetailView, CountView } from './counts.views'
import { pluginCountDetailView, pluginCountPage, pluginCountView } from './plugin-counts.views'

const count = (over: Partial<CountView> = {}): CountView => ({
  id: 'c-1',
  number: 'CT-0001',
  status: CountStatus.APPLIED,
  warehouse: { id: 'w-1', name: 'Main', code: 'MAIN' },
  storeId: 's-1',
  storeName: 'Store',
  note: null,
  createdBy: 'user-staff-1',
  startedAt: null,
  submittedAt: null,
  appliedBy: 'user-staff-2',
  appliedAt: new Date('2026-11-15T00:00:00Z'),
  createdAt: new Date('2026-11-14T00:00:00Z'),
  updatedAt: new Date('2026-11-15T00:00:00Z'),
  ...over
})

describe('the counts a plugin reads', () => {
  it('drops the ids of the people who opened and approved the count', () => {
    const view = pluginCountView(count())

    expect('createdBy' in view).toBe(false)
    expect('appliedBy' in view).toBe(false)
    expect(JSON.stringify(view)).not.toContain('user-staff')
  })

  it('names the fields one by one, so a new column does not reach a plugin', () => {
    const extra = { ...count(), organizationId: 'o-1' }

    expect(Object.keys(pluginCountView(extra)).sort()).toEqual(
      Object.keys(pluginCountView(count())).sort()
    )
    expect(JSON.stringify(pluginCountView(extra))).not.toContain('o-1')
  })

  it('answers a detail with its totals and lines and without the people, and a page the same way', () => {
    const detail: CountDetailView = {
      ...count(),
      totals: { lines: 1, counted: 1, withVariance: 0 },
      lines: [],
      nextCursor: null,
      hasMore: false
    }

    const view = pluginCountDetailView(detail)
    const page = pluginCountPage({ data: [count()], nextCursor: 'c', hasMore: true })

    expect(view.totals).toEqual({ lines: 1, counted: 1, withVariance: 0 })
    expect(JSON.stringify(view)).not.toContain('user-staff')
    expect(page.nextCursor).toBe('c')
    expect(JSON.stringify(page)).not.toContain('user-staff')
  })
})
