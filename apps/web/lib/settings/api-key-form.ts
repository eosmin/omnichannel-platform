import { ApiKeyLimits, ApiKeyScopePrefixes } from '@platform/core/domain'

import type { CreateApiKeyInput } from './api-keys-requests'

// The form of a new API key: a name, the scopes it holds and an optional last day. A scope is a permission of an
// integration's resource; a key can hold only what its maker holds, so only those are offered.

export interface ApiKeyDraft {
  name: string
  scopes: string[]
  // A day, "yyyy-mm-dd", or empty for a key that lasts until it is revoked
  expiresOn: string
}

export type ApiKeyProblem =
  'nameRequired' | 'nameTooLong' | 'noScopes' | 'expiryPast' | 'expiryInvalid'

export function emptyApiKeyDraft(): ApiKeyDraft {
  return { name: '', scopes: [], expiresOn: '' }
}

// The scopes the person may give: those a key may hold (the prefixes the platform allows) among the permissions they hold
// themselves. The api checks both again.
export function grantableScopes(held: readonly string[]): string[] {
  return held.filter(permission =>
    ApiKeyScopePrefixes.some(prefix => permission.startsWith(prefix))
  )
}

// The scopes by the resource they belong to (the text before the colon), in the order of the allowed prefixes
export interface ScopeGroup {
  resource: string
  scopes: string[]
}

export function scopeGroups(scopes: readonly string[]): ScopeGroup[] {
  return ApiKeyScopePrefixes.flatMap(prefix => {
    const inGroup = scopes.filter(scope => scope.startsWith(prefix))
    return inGroup.length === 0 ? [] : [{ resource: prefix.slice(0, -1), scopes: inGroup }]
  })
}

// Today as the date input writes it ("yyyy-mm-dd"), on the person's own clock: the first day a key may end on
export function todayInput(now: Date): string {
  const two = (value: number): string => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`
}

// The end of the chosen day, in the person's own clock: a key "until the 20th" works through the 20th
export function expiryInstant(day: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (match === null) return null
  const [, year, month, date] = match.map(Number)
  const instant = new Date(year ?? 0, (month ?? 1) - 1, date ?? 1, 23, 59, 59, 0)
  // 2026-02-31 rolls over to March and 2026-13-01 to the next year: those are not days
  return instant.getMonth() === (month ?? 1) - 1 && instant.getDate() === date ? instant : null
}

export function apiKeyProblems(draft: ApiKeyDraft, now: Date): ApiKeyProblem[] {
  const problems: ApiKeyProblem[] = []
  const name = draft.name.trim()
  if (name === '') problems.push('nameRequired')
  else if (name.length > ApiKeyLimits.NAME_MAX_LENGTH) problems.push('nameTooLong')
  if (draft.scopes.length === 0) problems.push('noScopes')
  if (draft.expiresOn !== '') {
    const instant = expiryInstant(draft.expiresOn)
    if (instant === null) problems.push('expiryInvalid')
    else if (instant.getTime() <= now.getTime()) problems.push('expiryPast')
  }
  return problems
}

// The body to send: only for a draft with no problem. A day that is not one throws instead of leaving the date out, which
// would make a key that never expires out of a person who asked for an end.
export function apiKeyInputOf(draft: ApiKeyDraft): CreateApiKeyInput {
  const instant = draft.expiresOn === '' ? null : expiryInstant(draft.expiresOn)
  if (draft.expiresOn !== '' && instant === null)
    throw new Error('the last day of the key is not a day')
  return {
    name: draft.name.trim(),
    scopes: draft.scopes,
    ...(instant === null ? {} : { expiresAt: instant.toISOString() })
  }
}
