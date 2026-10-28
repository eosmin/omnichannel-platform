// How long after the last message of a customer a channel lets the store answer with free text
// (TDD_10 §4). A channel that has no such rule has no policy at all.
export interface MessagingWindowPolicy {
  hours: number
  // WhatsApp lets an approved template through once the window is closed; Instagram and Messenger
  // do not let anything through
  requiresTemplateWhenClosed: boolean
  // Instagram and Messenger: when the customer's first message follows a click on an ad, the window
  // may last this many hours from that message ("up to": Meta does not promise it)
  extendedHoursAfterAd?: number
}
