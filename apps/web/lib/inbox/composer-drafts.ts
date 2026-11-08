import { z } from 'zod'

import { StorageKeys } from '@platform/api-client'

// The unsent text of the composer, kept per person, store and conversation so that moving to another
// conversation, a reload or a closed panel does not lose it. It lives in `sessionStorage`: it goes with the
// tab, is never shared with another tab or person of the same browser, and `clearComposerDrafts` empties it
// when the session ends. It is cleared as soon as the text is sent, because a customer's message is not kept
// longer than it takes to write it.
export type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export interface ComposerDraft {
  text: string
  // A note that came back as a reply would reach the customer: the kind is part of the draft
  isNote: boolean
  // The people a note named: the text alone does not notify them
  mentions: readonly { id: string; name: string }[]
}

// A draft older than this is dropped on read: an abandoned one does not keep a customer's text for the
// rest of the life of the tab
export const DRAFT_MAX_AGE_MS = 8 * 60 * 60 * 1000

export interface DraftScope {
  userId: string
  storeId: string
  conversationId: string
}

const stored = z.object({
  text: z.string(),
  isNote: z.boolean(),
  mentions: z.array(z.object({ id: z.string(), name: z.string() })).default([]),
  savedAt: z.number()
})

export function draftKey(scope: DraftScope): string {
  return `${StorageKeys.COMPOSER_DRAFT}:${scope.userId}:${scope.storeId}:${scope.conversationId}`
}

export function readDraft(
  storage: DraftStorage,
  scope: DraftScope,
  now: number = Date.now()
): ComposerDraft | null {
  let raw: string | null
  try {
    raw = storage.getItem(draftKey(scope))
  } catch {
    return null // Storage blocked: no draft
  }
  if (raw === null) return null
  try {
    const parsed = stored.safeParse(JSON.parse(raw))
    if (!parsed.success || parsed.data.text === '') return null
    if (now - parsed.data.savedAt > DRAFT_MAX_AGE_MS) {
      storage.removeItem(draftKey(scope))
      return null
    }
    const { text, isNote, mentions } = parsed.data
    return { text, isNote, mentions }
  } catch {
    return null
  }
}

// An empty text removes the draft: nothing is kept for a box that holds nothing
// Says whether it was kept (or removed) as asked: false when the storage refused, so that what shows the draft
// elsewhere does not show one that is not there
export function writeDraft(
  storage: DraftStorage,
  scope: DraftScope,
  draft: ComposerDraft,
  now: number = Date.now()
): boolean {
  try {
    if (draft.text.trim() === '') storage.removeItem(draftKey(scope))
    else storage.setItem(draftKey(scope), JSON.stringify({ ...draft, savedAt: now }))
    return true
  } catch {
    return false // Quota or blocked storage: the draft is not kept, the box still works
  }
}

// Every draft of this browser tab, whoever wrote it: used when the session ends
export function clearComposerDrafts(storage: Pick<Storage, 'key' | 'length' | 'removeItem'>): void {
  try {
    const keys: string[] = []
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (key?.startsWith(`${StorageKeys.COMPOSER_DRAFT}:`) === true) keys.push(key)
    }
    for (const key of keys) storage.removeItem(key)
  } catch {
    return
  }
}
