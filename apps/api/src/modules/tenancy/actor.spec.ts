import type { AuthenticatedRequest } from '@platform/core/logger'

import { actorOf } from './actor'

describe('actorOf', () => {
  const user = { id: 'u-1', sessionFamilyId: 'f-1', email: 'a@example.com' }

  it('names who acted, in which store, and from where', () => {
    const request = {
      ip: '203.0.113.9',
      get: (name: string) => (name === 'user-agent' ? 'jest' : undefined)
    } as unknown as AuthenticatedRequest

    expect(actorOf(user, { id: 's-1' }, request)).toEqual({
      userId: 'u-1',
      storeId: 's-1',
      ipAddress: '203.0.113.9',
      userAgent: 'jest'
    })
  })

  it('leaves out what the request does not say', () => {
    const request = { get: () => undefined } as unknown as AuthenticatedRequest

    expect(actorOf(user, { id: 's-1' }, request)).toEqual({
      userId: 'u-1',
      storeId: 's-1',
      ipAddress: undefined,
      userAgent: undefined
    })
  })
})
