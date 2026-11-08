import { useSyncExternalStore } from 'react'

import { StorageKeys } from '@platform/api-client'

import {
  type ComposerDraft,
  DRAFT_MAX_AGE_MS,
  type DraftScope,
  draftKey,
  readDraft
} from './composer-drafts'

// What the list of conversations shows of an unsent draft: the first words and the kind. The text itself stays
// where it was, in `sessionStorage` (`composer-drafts.ts`): this index only remembers, in memory, what each row
// needs, so that a row does not read the storage at every render and changes at once when the box is typed in.
// It is filled by what the composer writes and, for a conversation whose box was not opened in this tab, by one
// read of its key. It never leaves the page.
export interface DraftPreview {
  text: string
  isNote: boolean
}

// `at`: when the row learned it. The draft in the storage is dropped after `DRAFT_MAX_AGE_MS`, and so is this.
interface Entry {
  preview: DraftPreview | null
  at: number
}

// Enough for any row to draw: the row cuts the line, and a long draft is not held twice in memory
const PREVIEW_MAX_LENGTH = 200

const previews = new Map<string, Entry>()
const listeners = new Set<() => void>()
// Bumped on each change, so that a list built from the index is rebuilt only when it may have changed
let version = 0

function notify(): void {
  version += 1
  for (const listener of listeners) listener()
}

// One line, trimmed: a draft of only spaces is no draft
export function previewOfDraft(draft: Pick<ComposerDraft, 'text' | 'isNote'>): DraftPreview | null {
  const text = draft.text.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_MAX_LENGTH)
  return text === '' ? null : { text, isNote: draft.isNote }
}

// The composer says what it keeps, each time it writes
export function publishDraft(
  scope: DraftScope,
  draft: Pick<ComposerDraft, 'text' | 'isNote'>
): void {
  const key = draftKey(scope)
  const next = previewOfDraft(draft)
  const current = previews.get(key)?.preview
  if (current !== undefined && current?.text === next?.text && current?.isNote === next?.isNote)
    return
  previews.set(key, { preview: next, at: Date.now() })
  notify()
}

// When the session ends the drafts are erased (`clearComposerDrafts`) and so is what the rows remember
export function resetDraftIndex(): void {
  scannedScopes.clear()
  if (previews.size === 0) return
  previews.clear()
  notify()
}

function savedDraftPreview(scope: DraftScope): DraftPreview | null {
  try {
    const saved = readDraft(window.sessionStorage, scope)
    return saved === null ? null : previewOfDraft(saved)
  } catch {
    return null
  }
}

function snapshotOf(scope: DraftScope | null): DraftPreview | null {
  if (scope === null) return null
  const key = draftKey(scope)
  const known = previews.get(key)
  if (known !== undefined && Date.now() - known.at <= DRAFT_MAX_AGE_MS) return known.preview
  // First time this row asks: one read of its key. The result is kept, an empty one too.
  const preview = savedDraftPreview(scope)
  previews.set(key, { preview, at: Date.now() })
  return preview
}

export function subscribeToDrafts(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// The draft of one conversation, for its row. `null` scope: who is reading is not known yet.
export function useDraftPreview(scope: DraftScope | null): DraftPreview | null {
  return useSyncExternalStore(
    subscribeToDrafts,
    () => snapshotOf(scope),
    () => null
  )
}

// Which conversations of this person in this store have a draft (the filter "With draft"). The rows that were
// never typed in are found by listing the keys of the storage ONCE for the scope (a read of each key, not of the
// whole storage, and only when somebody asks for the filter); after that the index is kept by `publishDraft`.
const scannedScopes = new Set<string>()
const idLists = new Map<string, { version: number; expiresAt: number; ids: readonly string[] }>()
const NO_IDS: readonly string[] = []

function scanStorage(userId: string, storeId: string): void {
  const scopeKey = `${userId}:${storeId}`
  if (scannedScopes.has(scopeKey)) return
  const prefix = `${StorageKeys.COMPOSER_DRAFT}:${userId}:${storeId}:`
  try {
    const keys: string[] = []
    for (let at = 0; at < window.sessionStorage.length; at += 1) {
      const key = window.sessionStorage.key(at)
      if (key?.startsWith(prefix) === true) keys.push(key)
    }
    for (const key of keys) {
      if (previews.has(key)) continue
      snapshotOf({ userId, storeId, conversationId: key.slice(prefix.length) })
    }
    // Only after it was read: a storage that could not be read is asked again
    scannedScopes.add(scopeKey)
  } catch {
    // Storage blocked: there are no drafts to find
  }
}

export function conversationIdsWithDraft(userId: string, storeId: string): readonly string[] {
  const scopeKey = `${userId}:${storeId}`
  const cached = idLists.get(scopeKey)
  const now = Date.now()
  // Also not after the oldest draft of the list is old enough to be dropped: it leaves the list and the count
  if (cached !== undefined && cached.version === version && now < cached.expiresAt)
    return cached.ids
  scanStorage(userId, storeId)
  const prefix = `${StorageKeys.COMPOSER_DRAFT}:${userId}:${storeId}:`
  const ids = [...previews]
    .filter(
      ([key, entry]) =>
        key.startsWith(prefix) && entry.preview !== null && now - entry.at <= DRAFT_MAX_AGE_MS
    )
    .map(([key]) => key.slice(prefix.length))
    .sort()
  // The same ids: the same array, so that what depends on it does not run again
  const same =
    cached !== undefined &&
    cached.ids.length === ids.length &&
    cached.ids.every((id, at) => id === ids[at])
  const next = same ? cached.ids : ids
  const oldest = Math.min(
    ...[...previews]
      .filter(([key, entry]) => key.startsWith(prefix) && entry.preview !== null)
      .map(([, entry]) => entry.at)
  )
  idLists.set(scopeKey, { version, expiresAt: oldest + DRAFT_MAX_AGE_MS + 1, ids: next })
  return next
}

// The ids, sorted, of the conversations with a draft for this person in this store. Empty until the person is known.
export function useConversationIdsWithDraft(
  userId: string | undefined,
  storeId: string
): readonly string[] {
  return useSyncExternalStore(
    subscribeToDrafts,
    () => (userId === undefined ? NO_IDS : conversationIdsWithDraft(userId, storeId)),
    () => NO_IDS
  )
}
