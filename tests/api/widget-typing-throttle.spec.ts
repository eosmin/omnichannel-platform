import { WidgetLimits } from '@platform/core/domain'

import { WidgetTypingThrottle } from '../../apps/api/src/modules/widget/widget-typing-throttle'

const GAP = WidgetLimits.CUSTOMER_TYPING_GAP_MS
const SITE_MAX = WidgetLimits.CUSTOMER_TYPING_SITE_PER_MINUTE

describe('WidgetTypingThrottle', () => {
  it('takes one signal of a visitor per gap, and the next one once the gap is over', () => {
    const throttle = new WidgetTypingThrottle()

    expect(throttle.take('site', 'visitor', 1_000)).toBe(true)
    expect(throttle.take('site', 'visitor', 1_000 + GAP - 1)).toBe(false)
    expect(throttle.take('site', 'visitor', 1_000 + GAP)).toBe(true)
  })

  it('keeps the visitors of a site, and the same id on two sites, apart', () => {
    const throttle = new WidgetTypingThrottle()

    expect(throttle.take('site-a', 'visitor', 0)).toBe(true)
    expect(throttle.take('site-a', 'other', 0)).toBe(true)
    expect(throttle.take('site-b', 'visitor', 0)).toBe(true)
  })

  it('takes no more than the limit of a site in a minute, from any number of visitors, then starts again', () => {
    const throttle = new WidgetTypingThrottle()
    const taken = Array.from({ length: SITE_MAX + 5 }, (_, i) =>
      throttle.take('site', `visitor-${i}`, 10_000)
    )

    expect(taken.filter(Boolean)).toHaveLength(SITE_MAX)
    expect(throttle.take('other-site', 'visitor-0', 10_000)).toBe(true)
    expect(throttle.take('site', 'visitor-new', 10_000 + 60_000 - 1)).toBe(false)
    expect(throttle.take('site', 'visitor-new', 10_000 + 60_000)).toBe(true)
  })

  it('does not count a signal the gap refused against the limit of the site', () => {
    const throttle = new WidgetTypingThrottle()

    for (let i = 0; i < SITE_MAX * 2; i += 1) throttle.take('site', 'visitor', 5_000)

    expect(throttle.take('site', 'another', 5_000)).toBe(true)
  })
})
