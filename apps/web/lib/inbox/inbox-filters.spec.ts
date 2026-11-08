import { ConversationStatus } from '@platform/core/domain'

import {
  filtersFromParams,
  hasFilters,
  onlyDraftsFromParams,
  paramsFromFilters,
  searchOf,
  withOnlyDrafts
} from './inbox-filters'

const AGENT_ID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const TAG_ID = '3b241101-e2bb-4255-8caf-4136c566a962'

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

  it('reads the tag by its id and drops one that is not an id', () => {
    expect(filtersFromParams(new URLSearchParams(`tagId=${TAG_ID.toUpperCase()}`))).toEqual({
      tagId: TAG_ID
    })
    expect(filtersFromParams(new URLSearchParams('tagId=vip'))).toEqual({})
  })

  it('drops what is not valid instead of sending it to the api', () => {
    const params = new URLSearchParams('assigned=everyone&status=open&channelType=NOT%20AN%20ID!')

    expect(filtersFromParams(params)).toEqual({})
  })
})

describe('paramsFromFilters', () => {
  it('writes back what filtersFromParams reads', () => {
    const filters = {
      assigned: 'me',
      status: ConversationStatus.PENDING,
      channelType: 'instagram',
      tagId: TAG_ID
    }

    expect(filtersFromParams(paramsFromFilters(filters))).toEqual(filters)
  })

  it('is empty without filters', () => {
    expect(paramsFromFilters({}).toString()).toBe('')
    expect(hasFilters({})).toBe(false)
    expect(hasFilters({ status: ConversationStatus.OPEN })).toBe(true)
  })
})

describe('the view of the conversations with a draft', () => {
  it('is on only for draft=1, and is no filter of the api', () => {
    expect(onlyDraftsFromParams(new URLSearchParams('draft=1'))).toBe(true)
    expect(onlyDraftsFromParams(new URLSearchParams('draft=0'))).toBe(false)
    expect(onlyDraftsFromParams(new URLSearchParams('draft=yes&status=OPEN'))).toBe(false)
    expect(onlyDraftsFromParams(new URLSearchParams(''))).toBe(false)
    // What goes to the server does not carry it
    expect(filtersFromParams(new URLSearchParams('draft=1'))).toEqual({})
    expect(hasFilters(filtersFromParams(new URLSearchParams('draft=1')))).toBe(false)
  })

  it('is kept on the links with the filters, and is left out when it is off', () => {
    expect(searchOf({ status: ConversationStatus.OPEN }, true)).toBe('?status=OPEN&draft=1')
    expect(searchOf({ status: ConversationStatus.OPEN }, false)).toBe('?status=OPEN')
    expect(searchOf({}, true)).toBe('?draft=1')
    expect(searchOf({}, false)).toBe('')
  })

  it('is put in and taken out of an address without touching the rest of it', () => {
    const params = new URLSearchParams('status=OPEN&x=1')

    expect(withOnlyDrafts(params, true).toString()).toBe('status=OPEN&x=1&draft=1')
    expect(withOnlyDrafts(new URLSearchParams('draft=1&x=1'), false).toString()).toBe('x=1')
    // The address it was given is not changed
    expect(params.toString()).toBe('status=OPEN&x=1')
  })
})
