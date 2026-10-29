import { VISITOR_ID_PATTERN } from '@platform/core/domain'

const STORAGE_KEY = 'platform-widget-visitor'

// The visitor is anonymous: a random id kept in the browser, so the conversation is still theirs the
// next day. Storage can be refused (private windows, blocked site data), and then the id lives only
// as long as the page does.
export function loadVisitorId(storage: Pick<Storage, 'getItem' | 'setItem'> | null): string {
  try {
    const stored = storage?.getItem(STORAGE_KEY)
    if (stored !== null && stored !== undefined && VISITOR_ID_PATTERN.test(stored)) return stored
  } catch {
    // Falls through to a new id
  }
  const created = crypto.randomUUID()
  try {
    storage?.setItem(STORAGE_KEY, created)
  } catch {
    // Not kept; the next visit is a new visitor
  }
  return created
}

// Reading `window.localStorage` itself throws when the browser blocks it
export function browserStorage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}
