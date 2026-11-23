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
    [422, PushOutcomes.REFUSED_OTHER]
  ])('tells a %i apart', (status, outcome) => {
    expect(refusalOutcomeOf(pushError(status))).toBe(outcome)
  })

  it('files an error of the library or the certificate apart from the answers of a service', () => {
    expect(refusalOutcomeOf(new Error('bad key'))).toBe(PushOutcomes.REFUSED_LOCAL)
  })
})

describe('PushOutcomeWindow', () => {
  const fill = (
    window: PushOutcomeWindow,
    outcome: Parameters<PushOutcomeWindow['record']>[0],
    n: number
  ): void => {
    for (let i = 0; i < n; i += 1) window.record(outcome)
  }

  it('does not look sound when it is empty or has only refusals', () => {
    const window = new PushOutcomeWindow()
    expect(window.serverLooksSound()).toBe(false)
    fill(window, PushOutcomes.REFUSED_BAD_REQUEST, 30)
    fill(window, PushOutcomes.REFUSED_AUTH, 30)
    expect(window.serverLooksSound()).toBe(false)
  })

  it('looks sound after a delivered push', () => {
    const window = new PushOutcomeWindow()
    window.record(PushOutcomes.DELIVERED)
    expect(window.serverLooksSound()).toBe(true)
  })

  it('forgets a delivered push that is older than the window', () => {
    const window = new PushOutcomeWindow()
    window.record(PushOutcomes.DELIVERED)
    fill(window, PushOutcomes.REFUSED_BAD_REQUEST, PushLimits.SOUND_WINDOW)
    expect(window.serverLooksSound()).toBe(false)
  })
})
