import { NotificationTypes, notificationMessageKey } from './notification-constants'
import { bodyVariantOf, DigestLinkKinds, digestLinkKindOf } from './notification-presentation'

describe('digestLinkKindOf', () => {
  it.each([
    [NotificationTypes.CONVERSATION_UNASSIGNED_QUEUE, DigestLinkKinds.CONVERSATION],
    [NotificationTypes.MESSAGE_FAILED, DigestLinkKinds.CONVERSATION],
    [NotificationTypes.CHANNEL_DISCONNECTED, DigestLinkKinds.CHANNELS],
    [NotificationTypes.INVITATION_ACCEPTED, DigestLinkKinds.TEAM],
    [NotificationTypes.MEMBER_JOINED, DigestLinkKinds.TEAM],
    [NotificationTypes.EXPORT_READY, DigestLinkKinds.EXPORTS],
    [NotificationTypes.ORDER_CREATED, DigestLinkKinds.APP]
  ])('words the link of %s as %s', (type, kind) => {
    expect(digestLinkKindOf(notificationMessageKey(type))).toBe(kind)
  })

  it('opens the app for a key it does not know', () => {
    expect(digestLinkKindOf('notifications.future.thing')).toBe(DigestLinkKinds.APP)
  })
})

describe('bodyVariantOf', () => {
  const all = () => true
  const none = () => false

  it('says who and whose when both came, and how many when it stands for more than one', () => {
    const params = { author: 'Ana', customer: 'Lucia' }
    expect(bodyVariantOf(params, 1, all)).toBe('bodyWithPeople')
    expect(bodyVariantOf(params, 3, all)).toBe('bodyRepeated')
  })

  it('names the customer when only whose came', () => {
    expect(bodyVariantOf({ customer: 'Lucia' }, 1, all)).toBe('bodyWithCustomer')
    expect(bodyVariantOf({ customer: 'Lucia' }, 4, all)).toBe('bodyWithCustomer')
  })

  it('names the product of a low-stock notice, where the text exists', () => {
    const params = { product: 'Shoe', available: 2, threshold: 5 }
    expect(bodyVariantOf(params, 1, all)).toBe('bodyWithProduct')
    expect(bodyVariantOf(params, 1, none)).toBe('body')
    expect(bodyVariantOf({ product: 'Shoe' }, 1, all)).toBe('body')
    expect(bodyVariantOf({ product: 'Shoe', available: 2 }, 1, all)).toBe('body')
    expect(bodyVariantOf({ product: '  ', available: 1, threshold: 2 }, 1, all)).toBe('body')
    expect(bodyVariantOf({ product: 7 }, 1, all)).toBe('body')
    // A customer or an author keeps the conversation texts: the product text is not theirs
    expect(bodyVariantOf({ ...params, customer: 'Lucia' }, 1, all)).toBe('bodyWithCustomer')
  })

  it('does not name a customer that is empty or not a text', () => {
    expect(bodyVariantOf({ customer: '' }, 1, all)).toBe('body')
    expect(bodyVariantOf({ customer: '  ' }, 1, all)).toBe('body')
    expect(bodyVariantOf({ customer: 7 }, 1, all)).toBe('body')
  })

  it('keeps the plain text without the params, or where the type has no such text', () => {
    expect(bodyVariantOf({}, 1, all)).toBe('body')
    expect(bodyVariantOf({ author: 'Ana' }, 2, all)).toBe('body')
    expect(bodyVariantOf({ author: 'Ana', customer: 'Lucia' }, 2, none)).toBe('body')
    expect(bodyVariantOf({ customer: 'Lucia' }, 1, variant => variant !== 'bodyWithCustomer')).toBe(
      'body'
    )
  })
})
