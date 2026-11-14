import type { ModerateRiskMode, SafetySwitch } from '@platform/core/domain'

// What the store chose about its confirmations (`StoreSettings.safety`, TDD_09 §11.2), as the person in front of the
// screen needs it: with the role they hold in this store, which the rule of "apply to roles" reads.
export interface SafetyPolicy {
  role: string
  confirm: Record<SafetySwitch, boolean>
  applyToRoles: readonly string[]
  moderateRiskMode: ModerateRiskMode
}

// One policy at a time, the one of the store on screen. It is a variable of the module and not a React context because
// `DestructiveActionProvider` sits above the stores (the organization screens ask too) and reads it at the moment a
// confirmation is asked, never while it renders. Until a store's settings are read, and when they cannot be, there is no
// policy and every action asks as the tier table says: a missing setting never takes a confirmation away.
let current: SafetyPolicy | null = null

export function setSafetyPolicy(policy: SafetyPolicy | null): void {
  current = policy
}

export function currentSafetyPolicy(): SafetyPolicy | null {
  return current
}
