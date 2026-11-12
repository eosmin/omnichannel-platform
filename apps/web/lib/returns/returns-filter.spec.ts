import { OrderReturnStatus } from '@platform/core/domain'

import {
  asReturnsStatusFilter,
  EMPTY_RETURNS_FILTER,
  isReturnsFiltered,
  returnsFilterProblems,
  ReturnsFilterProblems,
  returnsListParams
} from './returns-filter'

describe('returnsListParams', () => {
  it('sends nothing for an empty filter', () => {
    expect(returnsListParams(EMPTY_RETURNS_FILTER)).toEqual({})
    expect(isReturnsFiltered(EMPTY_RETURNS_FILTER)).toBe(false)
  })

  it('sends only what is set, with the order number trimmed', () => {
    const draft = {
      status: OrderReturnStatus.REQUESTED,
      orderNumber: '  00041 ',
      createdFrom: '2026-11-01',
      createdTo: ''
    }
    expect(returnsListParams(draft)).toEqual({
      status: 'requested',
      orderNumber: '00041',
      createdFrom: '2026-11-01'
    })
    expect(isReturnsFiltered(draft)).toBe(true)
  })

  it('does not count blanks as a filter', () => {
    expect(isReturnsFiltered({ ...EMPTY_RETURNS_FILTER, orderNumber: '   ' })).toBe(false)
  })
})

describe('returnsFilterProblems', () => {
  it('accepts a range in order, a single day and an open range', () => {
    expect(
      returnsFilterProblems({
        ...EMPTY_RETURNS_FILTER,
        createdFrom: '2026-11-01',
        createdTo: '2026-11-01'
      })
    ).toEqual([])
    expect(returnsFilterProblems({ ...EMPTY_RETURNS_FILTER, createdTo: '2026-11-01' })).toEqual([])
  })

  it('refuses a range that goes backwards', () => {
    expect(
      returnsFilterProblems({
        ...EMPTY_RETURNS_FILTER,
        createdFrom: '2026-11-02',
        createdTo: '2026-11-01'
      })
    ).toEqual([ReturnsFilterProblems.RANGE_BACKWARDS])
  })

  it('refuses an order number longer than the api takes', () => {
    expect(returnsFilterProblems({ ...EMPTY_RETURNS_FILTER, orderNumber: '1'.repeat(41) })).toEqual(
      [ReturnsFilterProblems.ORDER_NUMBER_TOO_LONG]
    )
  })
})

describe('asReturnsStatusFilter', () => {
  it('knows the states and treats anything else as any state (null)', () => {
    expect(asReturnsStatusFilter('in_transit')).toBe(OrderReturnStatus.IN_TRANSIT)
    expect(asReturnsStatusFilter('')).toBeNull()
    expect(asReturnsStatusFilter('mystery')).toBeNull()
  })
})
