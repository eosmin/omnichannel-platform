import { WebPushError } from 'web-push'

import { PushLimits, PushOutcomes } from '@platform/core/notifications'

import { PushOutcomeWindow, refusalOutcomeOf } from './push-outcome'

const pushError = (status: number): WebPushError =>
  new WebPushError('refused', status, {}, '', 'https://fcm.googleapis.com/x')

describe('refusalOutcomeOf', () => {
  it.each([
    [400, PushOutcomes.REFUSED_BAD_REQUEST],
    [401, PushOutcomes.REFUSED_AUTH],
    [403, PushOutcomes.REFUSED_AUTH],
    [413, PushOutcomes.REFUSED_TOO_LARGE],
    [404 + 1, PushOutcomes.REFUSED_OTHER]
  ])('tells a %i apart', (status, outcome) => {
    expect(refusalOutcomeOf(pushError(status))).toBe(outcome)
  })

  it('files an error of the library under the other refusals', () => {
    expect(refusalOutcomeOf(new Error('bad key'))).toBe(PushOutcomes.REFUSED_OTHER)
  })
})

describe('PushOutcomeWindow', () => {
  const fill = (
    window: PushOutcomeWindow,
    outcome: Parameters<PushOutcomeWindow['record']>[0],
    n: number
  ) => {
    for (let i = 0; i < n; i += 1) window.record(outcome)
  }

  it('is not systemic before enough pushes are known, even if all were 400', () => {
    const window = new PushOutcomeWindow()
    fill(window, PushOutcomes.REFUSED_BAD_REQUEST, PushLimits.SYSTEMIC_MIN_SAMPLE - 1)
    expect(window.isSystemicBadRequest()).toBe(false)
  })

  it('is systemic when the share of 400s reaches the limit', () => {
    const window = new PushOutcomeWindow()
    fill(window, PushOutcomes.DELIVERED, PushLimits.SYSTEMIC_MIN_SAMPLE / 2)
    fill(window, PushOutcomes.REFUSED_BAD_REQUEST, PushLimits.SYSTEMIC_MIN_SAMPLE / 2)
    expect(window.isSystemicBadRequest()).toBe(true)
  })

  it('is not systemic while most pushes are delivered', () => {
    const window = new PushOutcomeWindow()
    fill(window, PushOutcomes.DELIVERED, PushLimits.SYSTEMIC_WINDOW)
    fill(window, PushOutcomes.REFUSED_BAD_REQUEST, 3)
    expect(window.isSystemicBadRequest()).toBe(false)
  })

  it('forgets what is older than the window', () => {
    const window = new PushOutcomeWindow()
    fill(window, PushOutcomes.REFUSED_BAD_REQUEST, PushLimits.SYSTEMIC_WINDOW)
    expect(window.isSystemicBadRequest()).toBe(true)
    fill(window, PushOutcomes.DELIVERED, PushLimits.SYSTEMIC_WINDOW)
    expect(window.isSystemicBadRequest()).toBe(false)
  })

  it('does not count a 401 or a 413 as a bad request', () => {
    const window = new PushOutcomeWindow()
    fill(window, PushOutcomes.REFUSED_AUTH, PushLimits.SYSTEMIC_WINDOW)
    expect(window.isSystemicBadRequest()).toBe(false)
  })
})
