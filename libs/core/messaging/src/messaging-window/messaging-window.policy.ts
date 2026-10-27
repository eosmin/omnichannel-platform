import type { ChannelId, MessagingWindowPolicy } from '@platform/core/domain'

// Where the policy of a channel comes from. The channel plugins own it (`plugin.messagingWindow`,
// TDD_10 §2); the core computes the window from it. A channel with no policy has no window.
export interface MessagingWindowPolicySource {
  policyFor(channelType: ChannelId): MessagingWindowPolicy | null
}

export const MESSAGING_WINDOW_POLICIES = Symbol('MESSAGING_WINDOW_POLICIES')
