import { CustomerTimelineTypes } from '@platform/core/domain'

import type { TimelinePage } from './customer-timeline.service'
import type { CustomerDetail } from './customers.views'
import {
  pluginCreatedCustomer,
  pluginCustomerDetail,
  pluginNote,
  pluginTimeline
} from './plugin-customers.views'

const at = new Date('2026-01-01T00:00:00Z')

describe('what a plugin sees of the team in a profile', () => {
  it('drops the author of a note', () => {
    const view = pluginNote({ id: 'n1', authorId: 'user-1', content: 'hi', createdAt: at })

    expect(view).toEqual({ id: 'n1', content: 'hi', createdAt: at })
  })

  it('drops the team members of the notes and merges of a timeline and keeps the rest', () => {
    const order = {
      type: CustomerTimelineTypes.ORDER,
      id: 'o1',
      at,
      orderNumber: 'T-1',
      status: 'PENDING',
      totalCents: 100,
      currency: 'USD'
    } as const
    const page = {
      data: [
        order,
        {
          type: CustomerTimelineTypes.NOTE,
          id: 'n1',
          at,
          authorId: 'user-1',
          authorName: 'Ana',
          content: 'hi'
        },
        {
          type: CustomerTimelineTypes.MERGE,
          id: 'm1',
          at,
          absorbedId: 'c2',
          mergedById: 'user-2',
          mergedByName: 'Luis',
          unmergeUntil: at,
          unmergedAt: null
        }
      ],
      nextCursor: 'next'
    } as unknown as TimelinePage

    const view = pluginTimeline(page)

    expect(view.nextCursor).toBe('next')
    expect(view.data[0]).toBe(order)
    const text = JSON.stringify(view)
    for (const hidden of ['user-1', 'user-2', 'Ana', 'Luis', 'authorId', 'mergedBy']) {
      expect(text).not.toContain(hidden)
    }
    expect(view.data[1]).toMatchObject({ id: 'n1', content: 'hi' })
    expect(view.data[2]).toMatchObject({ id: 'm1', absorbedId: 'c2' })
  })
})

describe('what a plugin sees of the caution flag of a customer', () => {
  const detail: CustomerDetail = {
    id: 'c1',
    name: 'Ana',
    email: null,
    phone: null,
    nationalPhone: null,
    locale: null,
    isCaution: true,
    cautionReason: 'text the team wrote about the person',
    erasedAt: null,
    identities: [],
    addresses: [],
    tags: [],
    createdAt: at,
    updatedAt: at
  }

  it('keeps the flag and drops the reason from the profile', () => {
    const view = pluginCustomerDetail(detail)

    expect(view.isCaution).toBe(true)
    expect(Object.keys(view)).not.toContain('cautionReason')
    expect(JSON.stringify(view)).not.toContain('text the team wrote')
  })

  it('drops the reason from the answer of a creation and keeps its possible duplicates', () => {
    const view = pluginCreatedCustomer({ ...detail, possibleDuplicates: [] })

    expect(Object.keys(view)).not.toContain('cautionReason')
    expect(view.possibleDuplicates).toEqual([])
  })

  it('names every field it lets through: a field added to the profile stays out until it is added here', () => {
    const expected = Object.keys(detail)
      .filter(key => key !== 'cautionReason' && key !== 'erasedAt')
      .sort()

    // `erasedAt` is for the screens of the team: a plugin is not told when a customer was erased (Step 7.2-F)
    expect(Object.keys(pluginCustomerDetail(detail))).not.toContain('erasedAt')
    expect(
      Object.keys(pluginCustomerDetail({ ...detail, extra: 'x' } as CustomerDetail)).sort()
    ).toEqual(expected)
  })
})
