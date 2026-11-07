import { failureNotesOf, failureStateOf } from './failure-state'

describe('failureStateOf', () => {
  it('is nothing for a reply that did not fail', () => {
    for (const status of ['queued', 'sent', 'delivered', 'read', null]) {
      expect(failureStateOf({ deliveryStatus: status, failureDefinitive: true })).toBeNull()
    }
  })

  it('is definitive only when the api knows it did not go out', () => {
    expect(failureStateOf({ deliveryStatus: 'failed', failureDefinitive: true })).toBe('definitive')
  })

  it('is unconfirmed when it may have gone out, and when the api does not say', () => {
    expect(failureStateOf({ deliveryStatus: 'failed', failureDefinitive: false })).toBe(
      'unconfirmed'
    )
    expect(failureStateOf({ deliveryStatus: 'failed', failureDefinitive: null })).toBe(
      'unconfirmed'
    )
    expect(failureStateOf({ deliveryStatus: 'failed' })).toBe('unconfirmed')
  })
})

describe('failureNotesOf', () => {
  const failed = (over: Record<string, unknown>) => ({
    deliveryStatus: 'failed',
    deliveryError: null,
    ...over
  })

  it('says nothing for a reply that did not fail', () => {
    expect(failureNotesOf({ deliveryStatus: 'sent', deliveryError: null })).toEqual([])
  })

  it('says the reason of a definitive failure, or only that it failed when there is none', () => {
    expect(
      failureNotesOf(
        failed({ failureDefinitive: true, deliveryError: 'CHANNEL_FILE_TYPE_UNSUPPORTED' })
      )
    ).toEqual([{ kind: 'reason', tone: 'red' }])
    expect(failureNotesOf(failed({ failureDefinitive: true }))).toEqual([
      { kind: 'failed', tone: 'red' }
    ])
  })

  it('keeps the reason in the amber state too, and adds that delivery could not be confirmed', () => {
    for (const failureDefinitive of [false, null, undefined]) {
      expect(
        failureNotesOf(
          failed({ failureDefinitive, deliveryError: 'CHANNEL_FILE_TYPE_UNSUPPORTED' })
        )
      ).toEqual([
        { kind: 'reason', tone: 'amber' },
        { kind: 'unconfirmed', tone: 'amber' }
      ])
    }
  })

  it('says only that it could not be confirmed when the amber state has no reason', () => {
    expect(failureNotesOf(failed({ failureDefinitive: false }))).toEqual([
      { kind: 'unconfirmed', tone: 'amber' }
    ])
  })
})
