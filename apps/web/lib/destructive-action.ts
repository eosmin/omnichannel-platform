import {
  type DestructiveAction,
  type DestructiveActionTier,
  DestructiveActionTierLevels,
  DestructiveActionTiers
} from '@platform/core/domain'

// How the interface asks before a destructive action (TDD_09 §11.1). The tier of each action is
// fixed in DestructiveActionTiers; the page that lets a store or a user lower it is Step 5.4.
export const ConfirmationStyles = {
  TYPED_PHRASE: 'typed_phrase',
  DIALOG: 'dialog',
  UNDO_TOAST: 'undo_toast'
} as const
export type ConfirmationStyle = (typeof ConfirmationStyles)[keyof typeof ConfirmationStyles]

const StyleByTier: Record<DestructiveActionTier, ConfirmationStyle> = {
  [DestructiveActionTierLevels.CRITICAL]: ConfirmationStyles.TYPED_PHRASE,
  [DestructiveActionTierLevels.HIGH]: ConfirmationStyles.DIALOG,
  [DestructiveActionTierLevels.MODERATE]: ConfirmationStyles.DIALOG,
  [DestructiveActionTierLevels.LOW]: ConfirmationStyles.UNDO_TOAST
}

export function confirmationStyleFor(action: DestructiveAction): ConfirmationStyle {
  return StyleByTier[DestructiveActionTiers[action]]
}

// The confirm button of a critical or high action is red; any other tier gets a plain button
export function needsDestructiveButton(action: DestructiveAction): boolean {
  const tier = DestructiveActionTiers[action]
  return tier === DestructiveActionTierLevels.CRITICAL || tier === DestructiveActionTierLevels.HIGH
}

export { phraseMatches } from '@platform/core/domain'
