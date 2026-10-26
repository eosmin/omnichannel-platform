// How long after the last message of a customer a channel lets the store answer with free text
// (TDD_10 §4). A channel that has no such rule has no policy at all.
export interface MessagingWindowPolicy {
  hours: number
  // WhatsApp lets an approved template through once the window is closed; Instagram and Messenger
  // do not let anything through
  requiresTemplateWhenClosed: boolean
}
