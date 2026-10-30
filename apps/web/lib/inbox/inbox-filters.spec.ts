import { ConversationStatus } from '@platform/core/domain'

import { filtersFromParams, hasFilters, paramsFromFilters } from './inbox-filters'

const AGENT_ID = '0f8fad5b-d9cb-469f-a165-70867728950e'

describe('filtersFromParams', () => {
  it('reads each filter the address names', () => {
    const params = new URLSearchParams(`assigned=${AGENT_ID}&status=OPEN&channelType=whatsapp`)

    expect(filtersFromParams(params)).toEqual({
      assigned: AGENT_ID,
      status: ConversationStatus.OPEN,
      channelType: 'whatsapp'
    })
  })

  it('reads the two words of assigned', () => {
    expect(filtersFromParams(new URLSearchParams('assigned=me'))).toEqual({ assigned: 'me' })
    expect(filtersFromParams(new URLSearchParams('assigned=unassigned'))).toEqual({
      assigned: 'unassigned'
    })
  })

  it('drops what is not valid instead of sending it to the api', () => {
    const params = new URLSearchParams('assigned=everyone&status=open&channelType=NOT%20AN%20ID!')

    expect(filtersFromParams(params)).toEqual({})
  })
})

describe('paramsFromFilters', () => {
  it('writes back what filtersFromParams reads', () => {
    const filters = { assigned: 'me', status: ConversationStatus.PENDING, channelType: 'instagram' }

    expect(filtersFromParams(paramsFromFilters(filters))).toEqual(filters)
  })

  it('is empty without filters', () => {
    expect(paramsFromFilters({}).toString()).toBe('')
    expect(hasFilters({})).toBe(false)
    expect(hasFilters({ status: ConversationStatus.OPEN })).toBe(true)
  })
})
