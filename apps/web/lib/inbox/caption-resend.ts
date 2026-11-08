import { CaptionState } from '@platform/core/domain'

type CaptionStateValue = (typeof CaptionState)[keyof typeof CaptionState]

// Only the text that may already be with the customer asks before it is sent again
export function asksBeforeResending(state: CaptionStateValue | null): boolean {
  return state === CaptionState.UNCONFIRMED
}
