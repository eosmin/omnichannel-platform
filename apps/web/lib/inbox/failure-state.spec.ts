import { failureStateOf } from './failure-state'

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
