// Names that go into the params of a notification

// The end of a handle a customer with no name is told apart by ("····ab98"): the whole handle is a
// phone number or a random id, not something to print in a text
const HANDLE_TAIL = 4

export function customerNameOf(conversation: {
  customer: { name: string | null }
  customerIdentity: { displayName: string | null; channelIdentity: string }
}): string {
  // The end of the handle is the customer's too (a widget visitor id, an address): same cleaning
  const end = Array.from(conversation.customerIdentity.channelIdentity).slice(-HANDLE_TAIL).join('')
  const tail = `····${textForParams(end) ?? ''}`
  for (const value of [conversation.customer.name, conversation.customerIdentity.displayName]) {
    const clean = value === null ? null : textForParams(value)
    if (clean !== null) return clean
  }
  return tail
}

// A name goes into the text of a notification and from there into an email: the name a customer gave
// their profile is theirs to choose, so it is cut and stripped of control and invisible characters
const PARAM_NAME_MAX = 80
const UNSAFE_IN_NAME = /[\p{Cc}\p{Cf}]/gu

export function textForParams(value: string): string | null {
  const clean = value.replace(UNSAFE_IN_NAME, ' ').replace(/\s+/g, ' ').trim()
  return clean === '' ? null : Array.from(clean).slice(0, PARAM_NAME_MAX).join('')
}
