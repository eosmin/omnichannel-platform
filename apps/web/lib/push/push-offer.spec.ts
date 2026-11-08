import { PushOffer, pushOfferFor, shouldSyncOnLoad } from './push-offer'

describe('pushOfferFor', () => {
  it('asks a browser that was never asked, once', () => {
    expect(pushOfferFor({ permission: 'default', alreadyOffered: false })).toBe(PushOffer.ASK)
    expect(pushOfferFor({ permission: 'default', alreadyOffered: true })).toBe(PushOffer.NONE)
  })

  it('registers again, with no question, a browser that already allows it', () => {
    expect(pushOfferFor({ permission: 'granted', alreadyOffered: true })).toBe(PushOffer.SYNC)
    expect(pushOfferFor({ permission: 'granted', alreadyOffered: false })).toBe(PushOffer.SYNC)
  })

  it('leaves alone a browser that said no or cannot do push', () => {
    expect(pushOfferFor({ permission: 'denied', alreadyOffered: false })).toBe(PushOffer.NONE)
    expect(pushOfferFor({ permission: null, alreadyOffered: false })).toBe(PushOffer.NONE)
  })
})

describe('shouldSyncOnLoad', () => {
  const base = { permission: 'granted', turnedOff: false, alreadySynced: false } as const

  it('registers again, once per page, a browser that allows push', () => {
    expect(shouldSyncOnLoad(base)).toBe(true)
    expect(shouldSyncOnLoad({ ...base, alreadySynced: true })).toBe(false)
  })

  it('leaves alone a browser that is blocked, never asked, unsupported, or switched off by the person', () => {
    for (const permission of ['denied', 'default', null] as const) {
      expect(shouldSyncOnLoad({ ...base, permission })).toBe(false)
    }
    expect(shouldSyncOnLoad({ ...base, turnedOff: true })).toBe(false)
  })
})
