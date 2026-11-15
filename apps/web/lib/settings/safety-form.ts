import { SafetyRoleNames, type SafetySwitch } from '@platform/core/domain'

import type { SafetyInput, SafetyView } from './safety-requests'

// The form of Settings → Safety and confirmations. The draft has the shape of what is stored, so there is no text to
// parse: three switches, the roles they apply to and the way the moderate actions are asked. The save sends only the keys
// that changed, because the api merges them and a key left alone must keep what someone else saved meanwhile.

export type SafetyDraft = SafetyView

export const SAFETY_SWITCHES: readonly SafetySwitch[] = [
  'confirmDeleteCustomer',
  'confirmDisconnectChannel',
  'confirmRemoveMember'
]

export function safetyDraftOf(view: SafetyView): SafetyDraft {
  return { ...view, applyToRoles: orderedRoles(view.applyToRoles) }
}

// The order of the preset, whatever order the clicks came in, so that two lists with the same roles are equal
function orderedRoles(roles: readonly string[]): SafetyView['applyToRoles'] {
  return SafetyRoleNames.filter(role => roles.includes(role))
}

export function toggleRole(
  draft: SafetyDraft,
  role: SafetyDraft['applyToRoles'][number]
): SafetyDraft {
  const next = draft.applyToRoles.includes(role)
    ? draft.applyToRoles.filter(held => held !== role)
    : [...draft.applyToRoles, role]
  return { ...draft, applyToRoles: orderedRoles(next) }
}

function sameRoles(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every(role => b.includes(role))
}

// What the draft changes with respect to what is saved; empty when it changes nothing
export function safetyInputOf(saved: SafetyView, draft: SafetyDraft): SafetyInput {
  const input: SafetyInput = {}
  for (const key of SAFETY_SWITCHES) {
    if (draft[key] !== saved[key]) input[key] = draft[key]
  }
  if (!sameRoles(draft.applyToRoles, saved.applyToRoles)) {
    input.applyToRoles = orderedRoles(draft.applyToRoles)
  }
  if (draft.moderateRiskMode !== saved.moderateRiskMode) {
    input.moderateRiskMode = draft.moderateRiskMode
  }
  return input
}

export function safetyChanged(saved: SafetyView, draft: SafetyDraft): boolean {
  return Object.keys(safetyInputOf(saved, draft)).length > 0
}
