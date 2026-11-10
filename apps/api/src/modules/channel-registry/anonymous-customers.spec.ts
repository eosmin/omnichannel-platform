import type { ChannelAnonymitySource } from '@platform/core/domain'

import {
  withAnonymousCustomers,
  withAnonymousIdentities,
  withAnonymousPage
} from './anonymous-customers'

const source: ChannelAnonymitySource = { anonymousOf: channelType => channelType === 'visitors' }

describe('anonymous customers of a view', () => {
  it('marks a conversation by the channel that serves it', () => {
    expect(withAnonymousCustomers(source, { id: 'c1', channelType: 'visitors' })).toEqual({
      id: 'c1',
      channelType: 'visitors',
      anonymousCustomers: true
    })
    expect(withAnonymousCustomers(source, { id: 'c2', channelType: 'named' })).toEqual({
      id: 'c2',
      channelType: 'named',
      anonymousCustomers: false
    })
  })

  it('marks every row of a page and keeps the cursor', () => {
    const page = withAnonymousPage(source, {
      data: [
        { id: 'a', channelType: 'visitors' },
        { id: 'b', channelType: 'named' }
      ],
      nextCursor: 'next',
      hasMore: true
    })
    expect(page.data.map(row => row.anonymousCustomers)).toEqual([true, false])
    expect(page.nextCursor).toBe('next')
    expect(page.hasMore).toBe(true)
  })

  it('marks each identity of a customer by its own channel', () => {
    const customer = withAnonymousIdentities(source, {
      id: 'u1',
      identities: [
        { id: 'i1', channelType: 'named' },
        { id: 'i2', channelType: 'visitors' }
      ]
    })
    expect(customer.identities.map(identity => identity.anonymousCustomers)).toEqual([false, true])
    expect(customer.id).toBe('u1')
  })
})
