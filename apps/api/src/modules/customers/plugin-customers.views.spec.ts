import { CustomerTimelineTypes } from '@platform/core/domain'

import type { TimelinePage } from './customer-timeline.service'
import { pluginNote, pluginTimeline } from './plugin-customers.views'

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
