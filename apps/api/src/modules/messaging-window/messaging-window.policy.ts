import type { ChannelType, MessagingWindowPolicy } from '@platform/core/domain'

// Where the policy of a channel comes from. The channel plugins own it (`plugin.messagingWindow`,
// TDD_10 §2); the core computes the window from it. A channel with no policy has no window.
export interface MessagingWindowPolicySource {
  policyFor(channelType: ChannelType): MessagingWindowPolicy | null
}

export const MESSAGING_WINDOW_POLICIES = Symbol('MESSAGING_WINDOW_POLICIES')

// Until the plugin registry exists (Step 2.5) no channel has a window: nothing can be sent yet, so
// nothing is refused wrongly, and Step 2.5 binds the registry here
export const NO_MESSAGING_WINDOWS: MessagingWindowPolicySource = {
  policyFor: () => null
}
