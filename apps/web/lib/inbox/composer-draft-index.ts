import { useSyncExternalStore } from 'react'

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

function notify(): void {
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
