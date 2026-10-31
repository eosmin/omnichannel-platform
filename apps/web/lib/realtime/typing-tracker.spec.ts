import { TypingTiming } from '@platform/core/realtime'

import { type TypingSnapshot, TypingTracker } from './typing-tracker'

describe('TypingTracker', () => {
  let last: TypingSnapshot | undefined
  let tracker: TypingTracker

  beforeEach(() => {
    jest.useFakeTimers()
    last = undefined
    tracker = new TypingTracker(snapshot => {
      last = snapshot
    })
  })

  afterEach(() => {
    tracker.dispose()
    jest.useRealTimers()
  })

  it('shows the customer until the signal lapses', () => {
    tracker.customerTyping()
    expect(last?.isCustomerTyping).toBe(true)
    jest.advanceTimersByTime(TypingTiming.CUSTOMER_LAPSE_MS)
    expect(last?.isCustomerTyping).toBe(false)
  })

  it('keeps the customer while signals keep coming', () => {
    tracker.customerTyping()
    jest.advanceTimersByTime(TypingTiming.CUSTOMER_LAPSE_MS - 1)
    tracker.customerTyping()
    jest.advanceTimersByTime(TypingTiming.CUSTOMER_LAPSE_MS - 1)
    expect(last?.isCustomerTyping).toBe(true)
  })

  it('clears the customer when their message arrives', () => {
    tracker.customerTyping()
    tracker.clearCustomer()
    expect(last?.isCustomerTyping).toBe(false)
  })

  it('lists teammates in the order they started, once each', () => {
    tracker.teammateStart('u1', 'Ana')
    tracker.teammateStart('u2', 'Luis')
    tracker.teammateStart('u1', 'Ana')
    expect(last?.teammates).toEqual(['Ana', 'Luis'])
    tracker.teammateStop('u1')
    expect(last?.teammates).toEqual(['Luis'])
  })

  it('drops a teammate whose stop never came', () => {
    tracker.teammateStart('u1', 'Ana')
    jest.advanceTimersByTime(TypingTiming.TEAMMATE_LAPSE_MS)
    expect(last?.teammates).toEqual([])
  })

  it('keeps the customer when a teammate stops', () => {
    tracker.customerTyping()
    tracker.teammateStart('u1', 'Ana')
    tracker.teammateStop('u1')
    expect(last?.isCustomerTyping).toBe(true)
  })

  it('ignores a stop of someone who never started', () => {
    tracker.teammateStop('u9')
    expect(last).toBeUndefined()
  })
})
