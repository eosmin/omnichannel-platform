import {
  activeFilterCount,
  paramsFromState,
  stateFromParams,
  withScheduledDays,
  withScheduledShortcut
} from './order-filters'

const from = (query: string) => stateFromParams(new URLSearchParams(query))
const ID = '3f2b8c1a-0d4e-4f6a-9b7c-1a2b3c4d5e6f'

describe('the orders address', () => {
  it('reads every filter and the sort it knows', () => {
    const state = from(
      `q=ana&status=CONFIRMED&paymentStatus=PENDING&customerId=${ID}&createdFrom=2026-11-01&createdTo=2026-11-10&scheduledDeliveryFrom=2026-11-12&scheduledDeliveryTo=2026-11-14&sort=scheduled_delivery`
    )
    expect(state).toEqual({
      filter: {
        q: 'ana',
        status: 'CONFIRMED',
        paymentStatus: 'PENDING',
        customerId: ID,
        createdFrom: '2026-11-01',
        createdTo: '2026-11-10',
        scheduledDeliveryFrom: '2026-11-12',
        scheduledDeliveryTo: '2026-11-14'
      },
      sort: 'scheduled_delivery'
    })
  })

  it('leaves out what the api would refuse: unknown values, bad days, bad ids', () => {
    expect(
      from('status=NOPE&paymentStatus=x&customerId=1&createdFrom=11/01/2026&sort=oldest')
    ).toEqual({
      filter: {},
      sort: 'newest'
    })
    expect(from('createdFrom=2026-02-30').filter).toEqual({})
  })

  it('lets the shortcut win over the days, and drops an inverted range', () => {
    expect(from('scheduledDeliveryOn=today&scheduledDeliveryFrom=2026-11-01').filter).toEqual({
      scheduledDeliveryOn: 'today'
    })
    expect(from('createdFrom=2026-11-10&createdTo=2026-11-01').filter).toEqual({})
    expect(from('scheduledDeliveryFrom=2026-11-10&scheduledDeliveryTo=2026-11-01').filter).toEqual(
      {}
    )
  })

  it('writes nothing for the default sort and an empty filter, and round-trips the rest', () => {
    expect(paramsFromState({ filter: {}, sort: 'newest' })).toEqual([])
    const state = from('q=ana&scheduledDeliveryOn=tomorrow&sort=scheduled_delivery')
    expect(from(new URLSearchParams(paramsFromState(state)).toString())).toEqual(state)
  })

  it('counts the filters, not the sort', () => {
    expect(activeFilterCount({})).toBe(0)
    expect(activeFilterCount({ q: 'a', status: 'SHIPPED' })).toBe(2)
  })

  it('never sends a shortcut next to days', () => {
    const days = withScheduledDays({ q: 'a', scheduledDeliveryOn: 'today' }, { from: '2026-11-01' })
    expect(days).toEqual({ q: 'a', scheduledDeliveryFrom: '2026-11-01' })
    expect(withScheduledShortcut(days, 'tomorrow')).toEqual({
      q: 'a',
      scheduledDeliveryOn: 'tomorrow'
    })
    expect(withScheduledShortcut({ scheduledDeliveryOn: 'today' }, undefined)).toEqual({})
  })
})
