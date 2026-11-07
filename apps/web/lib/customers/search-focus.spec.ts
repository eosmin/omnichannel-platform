import { askSearchFocus, SEARCH_FOCUS_REQUEST_TTL_MS, takeSearchFocus } from './search-focus'

describe('search focus request', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    takeSearchFocus()
  })
  afterEach(() => jest.useRealTimers())

  it('is not wanted unless someone asked', () => {
    expect(takeSearchFocus()).toBe(false)
  })

  it('is given once for each request', () => {
    askSearchFocus()
    expect(takeSearchFocus()).toBe(true)
    expect(takeSearchFocus()).toBe(false)
  })

  it('expires when the page does not take it soon, so a later visit that did not ask is left alone', () => {
    askSearchFocus()
    jest.advanceTimersByTime(SEARCH_FOCUS_REQUEST_TTL_MS + 1)
    expect(takeSearchFocus()).toBe(false)
  })
})
