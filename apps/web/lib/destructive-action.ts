import {
  type DestructiveAction,
  type DestructiveActionTier,
  DestructiveActionTierLevels,
  DestructiveActionTiers,
  ModerateRiskModes,
  SafetyRoleNames,
  SafetySwitchedActions
} from '@platform/core/domain'

import { currentSafetyPolicy, type SafetyPolicy } from './safety-policy'

// How the interface asks before a destructive action (TDD_09 §11.1). The tier of each action is
// fixed in DestructiveActionTiers; what a store lowers on Settings → Safety and confirmations (§11.2) is read by
// `confirmationStyleFor`.
export const ConfirmationStyles = {
  TYPED_PHRASE: 'typed_phrase',
  DIALOG: 'dialog',
  UNDO_TOAST: 'undo_toast',
  // The store chose not to be asked: the action runs, with no dialog and no undo
  NONE: 'none'
} as const
export type ConfirmationStyle = (typeof ConfirmationStyles)[keyof typeof ConfirmationStyles]

const StyleByTier: Record<DestructiveActionTier, ConfirmationStyle> = {
  [DestructiveActionTierLevels.CRITICAL]: ConfirmationStyles.TYPED_PHRASE,
  [DestructiveActionTierLevels.HIGH]: ConfirmationStyles.DIALOG,
  [DestructiveActionTierLevels.MODERATE]: ConfirmationStyles.DIALOG,
  [DestructiveActionTierLevels.LOW]: ConfirmationStyles.UNDO_TOAST
}

// `hasUndo`: the caller can take the action back. A moderate action that the store wants as an undo toast is asked with a
// dialog when it cannot be undone, because an action with no way back must not lose its confirmation.
export function confirmationStyleFor(
  action: DestructiveAction,
  hasUndo = false,
  policy: SafetyPolicy | null = currentSafetyPolicy()
): ConfirmationStyle {
  const tier = DestructiveActionTiers[action]
  const base = StyleByTier[tier]
  // The critical tier is never a setting, the low one never asks, and with no policy the tier table is the rule
  if (policy === null || base === ConfirmationStyles.TYPED_PHRASE) return base
  if (tier === DestructiveActionTierLevels.MODERATE) {
    if (policy.moderateRiskMode === ModerateRiskModes.NONE) return ConfirmationStyles.NONE
    if (policy.moderateRiskMode === ModerateRiskModes.UNDO && hasUndo) {
      return ConfirmationStyles.UNDO_TOAST
    }
    return base
  }
  if (tier === DestructiveActionTierLevels.HIGH && Object.hasOwn(SafetySwitchedActions, action)) {
    const key = SafetySwitchedActions[action as keyof typeof SafetySwitchedActions]
    // A role that is not one of the preset (a custom role) is never in the list and always asks
    const isPresetRole = (SafetyRoleNames as readonly string[]).includes(policy.role)
    const stops =
      isPresetRole && (!policy.confirm[key] || !policy.applyToRoles.includes(policy.role))
    return stops ? ConfirmationStyles.NONE : base
  }
  return base
}

// The confirm button of a critical or high action is red; any other tier gets a plain button
export function needsDestructiveButton(action: DestructiveAction): boolean {
  const tier = DestructiveActionTiers[action]
  return tier === DestructiveActionTierLevels.CRITICAL || tier === DestructiveActionTierLevels.HIGH
}

// Whitespace around either text is not an error (a store name can end in a space); the case is,
// because the phrase is a name the user has to read and copy. The api applies the same rule
// (`phraseMatches` in libs/core/domain/text.ts); it is written here too because the web bundle of the
// inbox has 0.16 KB of room under its ceiling and the domain barrel is not worth the bytes.
export function phraseMatches(typed: string, phrase: string): boolean {
  return typed.trim() === phrase.trim()
}
