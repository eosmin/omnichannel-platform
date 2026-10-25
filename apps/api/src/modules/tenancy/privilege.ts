import type { Permission } from '@platform/core/auth'

// Nobody grants, takes away or touches what they do not have themselves: a member who may manage
// roles but cannot do something must not be able to hand that out, nor to lower someone who can.
// The permissions of `needed` that `held` lacks.
export function missingPermissions(
  held: readonly Permission[],
  needed: readonly string[]
): string[] {
  const owned = new Set<string>(held)
  return needed.filter(permission => !owned.has(permission))
}
