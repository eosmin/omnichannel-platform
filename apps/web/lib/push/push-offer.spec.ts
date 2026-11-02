import { PushOffer, pushOfferFor } from './push-offer'

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
