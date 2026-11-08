import { asksBeforeResending } from './caption-resend'

describe('asksBeforeResending', () => {
  it('asks first only when the customer may already have the text', () => {
    expect(asksBeforeResending('unconfirmed')).toBe(true)
    expect(asksBeforeResending('failed')).toBe(false)
    expect(asksBeforeResending('queued')).toBe(false)
    expect(asksBeforeResending(null)).toBe(false)
  })
})
