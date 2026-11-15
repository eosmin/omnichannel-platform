import { timingSafeEqual } from 'node:crypto'

import type { Permission } from '@platform/core/auth'
import { PluginChallenge, PluginInstallLimits } from '@platform/core/domain'
import { type PluginScope, PluginScopePermissions, PluginScopes } from '@platform/plugins/sdk'

// The rules of the install flow that need no database, no Redis and no network (the service holds the rest), so that they are
// tested on their own and never import the env of the app.

const SCOPE_VALUES: ReadonlySet<string> = new Set(Object.values(PluginScopes))

export function isPluginScope(value: string): value is PluginScope {
  return SCOPE_VALUES.has(value)
}

// The scopes of a list that exist, once each, in a stable order. A row written some other way cannot give a plugin a scope the
// platform does not declare.
export function knownScopes(values: readonly string[]): PluginScope[] {
  return [...new Set(values)].filter(isPluginScope).sort()
}

// The same set of scopes, whatever the order
export function sameScopes(left: readonly string[], right: readonly string[]): boolean {
  const a = knownScopes(left)
  const b = knownScopes(right)
  return a.length === b.length && a.every((scope, index) => scope === b[index])
}

// What a newer manifest asks for beyond what an installation holds, and what it no longer asks for
export function scopeChanges(
  granted: readonly string[],
  asked: readonly string[]
): { added: PluginScope[]; removed: PluginScope[] } {
  const held = new Set(granted)
  const wanted = new Set(asked)
  return {
    added: knownScopes(asked).filter(scope => !held.has(scope)),
    removed: knownScopes(granted).filter(scope => !wanted.has(scope))
  }
}

// The human permissions a set of scopes stands for: a plugin can do no more than they say (TDD_10 §6.2)
export function permissionsOfScopes(scopes: readonly string[]): Permission[] {
  return [...new Set(knownScopes(scopes).flatMap(scope => PluginScopePermissions[scope]))]
}

// The requests a minute an installation may make: what the manifest asks for, or the default
export function rateLimitOf(manifest: {
  limits?: { maxRequestsPerMinute?: number | undefined } | undefined
}): number {
  return manifest.limits?.maxRequestsPerMinute ?? PluginInstallLimits.DEFAULT_REQUESTS_PER_MINUTE
}

// What the platform posts to the webhook endpoint of a plugin before it trusts the address
export function challengeBody(pluginId: string, challenge: string): string {
  return JSON.stringify({
    type: PluginChallenge.TYPE,
    pluginId,
    [PluginChallenge.FIELD]: challenge
  })
}

// The plugin answered the challenge when its JSON answer carries the same value, compared in constant time
export function isChallengeAnswered(answer: string, challenge: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(answer)
  } catch {
    return false
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false
  const echoed = (parsed as Record<string, unknown>)[PluginChallenge.FIELD]
  if (typeof echoed !== 'string') return false
  const given = Buffer.from(echoed)
  const wanted = Buffer.from(challenge)
  return given.length === wanted.length && timingSafeEqual(given, wanted)
}

// The shape of a setup code (base64url of 32 bytes): anything else is not one, and is not looked up
const SETUP_CODE = new RegExp(
  `^[A-Za-z0-9_-]{${Math.ceil((PluginInstallLimits.SETUP_CODE_BYTES * 4) / 3)}}$`
)
export function isSetupCode(value: string): boolean {
  return SETUP_CODE.test(value)
}

// `Authorization: Bearer <key>`; the scheme is case-insensitive (RFC 7235)
const BEARER = /^Bearer (\S+)$/i
export function bearerTokenOf(header: string | undefined): string | undefined {
  return BEARER.exec(header ?? '')?.[1]
}
