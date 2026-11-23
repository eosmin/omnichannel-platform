import type { Translate } from '../../lib/use-error-text'

// The words of the data requests screens for a value the api sends as text. A value this page has no words for (a newer server) is said
// generically, never as the raw code: the person reading it is a reviewer, not a developer.
export function labelOf(t: Translate, group: string, value: string | null): string {
  const key = `${group}.${value ?? ''}`
  return value !== null && t.has(key) ? t(key) : t(`${group}.unknown`)
}
