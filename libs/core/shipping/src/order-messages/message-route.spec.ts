import { OrderMessageNotSentReasons, OrderMessageRoutes } from '@platform/core/domain'

import {
  automaticDispatchKey,
  creationDispatchKey,
  decideOrderMessageRoute,
  manualDispatchKey,
  pressedDispatchKey,
  type OrderMessageRouteInput
} from './message-route'

const open: OrderMessageRouteInput['channel'] = {
  hasWindow: true,
  windowOpen: true,
  takesTemplates: true,
  template: 'none'
}

const input = (over: Partial<OrderMessageRouteInput>): OrderMessageRouteInput => ({
  channel: open,
  hasEmail: false,
  ...over
})

describe('decideOrderMessageRoute', () => {
  it('sends free text through a channel that declares no window, at any time', () => {
    const channel = {
      hasWindow: false,
      windowOpen: false,
      takesTemplates: false,
      template: 'none'
    } as const
    expect(decideOrderMessageRoute(input({ channel }))).toEqual({
      route: OrderMessageRoutes.CHANNEL_TEXT
    })
  })

  it('ignores a linked template for a channel with no window', () => {
    const channel = {
      hasWindow: false,
      windowOpen: false,
      takesTemplates: true,
      template: 'usable'
    } as const
    expect(decideOrderMessageRoute(input({ channel }))).toEqual({
      route: OrderMessageRoutes.CHANNEL_TEXT
    })
  })

  it('sends free text inside the window', () => {
    expect(decideOrderMessageRoute(input({ channel: { ...open, template: 'usable' } }))).toEqual({
      route: OrderMessageRoutes.CHANNEL_TEXT
    })
  })

  it('sends the approved template outside the window', () => {
    const channel = { ...open, windowOpen: false, template: 'usable' } as const
    expect(decideOrderMessageRoute(input({ channel }))).toEqual({
      route: OrderMessageRoutes.CHANNEL_TEMPLATE
    })
  })

  it('falls back to email outside the window with no template', () => {
    const channel = { ...open, windowOpen: false } as const
    expect(decideOrderMessageRoute(input({ channel, hasEmail: true }))).toEqual({
      route: OrderMessageRoutes.EMAIL
    })
  })

  it('falls back to email when the linked template cannot be used', () => {
    const channel = { ...open, windowOpen: false, template: 'unusable' } as const
    expect(decideOrderMessageRoute(input({ channel, hasEmail: true }))).toEqual({
      route: OrderMessageRoutes.EMAIL
    })
  })

  it('is not sent, with the window as reason, when nothing else is left', () => {
    const channel = { ...open, windowOpen: false } as const
    expect(decideOrderMessageRoute(input({ channel }))).toEqual({
      route: OrderMessageRoutes.NOT_SENT,
      reason: OrderMessageNotSentReasons.WINDOW_CLOSED
    })
  })

  it('names the template when that was what failed', () => {
    const channel = { ...open, windowOpen: false, template: 'unusable' } as const
    expect(decideOrderMessageRoute(input({ channel }))).toEqual({
      route: OrderMessageRoutes.NOT_SENT,
      reason: OrderMessageNotSentReasons.TEMPLATE_UNAVAILABLE
    })
  })

  it('does not send a template through a channel that does not take them, usable or not, and says the window', () => {
    for (const template of ['usable', 'unusable'] as const) {
      const channel = { ...open, windowOpen: false, takesTemplates: false, template } as const
      expect(decideOrderMessageRoute(input({ channel, hasEmail: true }))).toEqual({
        route: OrderMessageRoutes.EMAIL
      })
      expect(decideOrderMessageRoute(input({ channel }))).toEqual({
        route: OrderMessageRoutes.NOT_SENT,
        reason: OrderMessageNotSentReasons.WINDOW_CLOSED
      })
    }
  })

  it('goes by email when the order has no channel and the customer has an address', () => {
    expect(decideOrderMessageRoute({ channel: null, hasEmail: true })).toEqual({
      route: OrderMessageRoutes.EMAIL
    })
  })

  it('is not sent when there is no channel and no address', () => {
    expect(decideOrderMessageRoute({ channel: null, hasEmail: false })).toEqual({
      route: OrderMessageRoutes.NOT_SENT,
      reason: OrderMessageNotSentReasons.NO_CHANNEL
    })
  })
})

describe('dispatch keys', () => {
  it('keys an automatic message by shipment, status and kind', () => {
    expect(automaticDispatchKey('s1', 'DELIVERED', 'order_delivered')).toBe(
      'auto:s1:DELIVERED:order_delivered'
    )
  })

  it('keys a failed attempt of the same shipment by its number', () => {
    expect(automaticDispatchKey('s1', 'FAILED_ATTEMPT', 'order_failed_attempt', 2)).toBe(
      'auto:s1:FAILED_ATTEMPT:order_failed_attempt:2'
    )
  })

  it('keys a manual change by order, kind and status', () => {
    expect(manualDispatchKey('o1', 'order_cancelled', 'CANCELLED')).toBe(
      'manual:o1:order_cancelled:CANCELLED'
    )
  })

  it('keys a press of the send button by the key its client made', () => {
    expect(pressedDispatchKey('o1', 'order_summary', 'k1')).toBe('pressed:o1:order_summary:k1')
    expect(pressedDispatchKey('o1', 'order_summary', 'k2')).not.toBe(
      pressedDispatchKey('o1', 'order_summary', 'k1')
    )
  })

  it('keys the summary of a creation by the order alone', () => {
    expect(creationDispatchKey('o1')).toBe('created:o1')
  })

  it('never repeats a key between the families', () => {
    expect(creationDispatchKey('x')).not.toBe(manualDispatchKey('x', 'order_summary', 'CREATED'))
    expect(creationDispatchKey('x')).not.toBe(automaticDispatchKey('x', 'CREATED', 'order_summary'))
    expect(automaticDispatchKey('x', 'CANCELLED', 'order_cancelled')).not.toBe(
      manualDispatchKey('x', 'order_cancelled', 'CANCELLED')
    )
  })
})
