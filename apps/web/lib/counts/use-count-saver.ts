'use client'

import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'

import { type CountDetailView, type CountLineView, QueryKeys } from '@platform/api-client'
import { CountLimits } from '@platform/core/domain'

import { chunkEdits, loadDraft, onlyLinesOf, saveDraft, withoutConfirmed } from './count-draft'
import { isRetryableSaveError } from './count-save-error'
import type { CountEdits } from './count-sheet'
import { useSaveCountLines } from './use-counts'

// How long after the last key the quantities go to the api, and how often a send that failed for want of a signal is
// tried again while the page is open
export const SAVE_DELAY_MS = 800
export const RETRY_DELAY_MS = 15_000

export const SaverStates = {
  SAVED: 'saved',
  PENDING: 'pending',
  SAVING: 'saving',
  // The quantities are kept on the phone; the send will be tried again (no signal) or needs the person (a refusal)
  OFFLINE: 'offline',
  REFUSED: 'refused'
} as const
export type SaverState = (typeof SaverStates)[keyof typeof SaverStates]

export interface CountSaver {
  edits: CountEdits
  state: SaverState
  error: unknown
  // Types a quantity (null takes one back); it is sent a moment later
  setQuantity: (lineId: string, quantity: number | null) => void
  // Sends what is waiting now. True when nothing is left unsaved.
  flush: () => Promise<boolean>
}

// What a person types on a count sheet: kept on screen, in the browser (a closed tab or a dead battery does not lose it)
// and sent to the api a moment after the last key, a few rows at a time. A send that fails for want of a signal is
// tried again by itself; a refusal of the api is shown and waits for the person. The api stays the one that decides.
export function useCountSaver(
  storeId: string,
  userId: string | undefined,
  countId: string,
  lines: readonly CountLineView[] | undefined
): CountSaver {
  const queryClient = useQueryClient()
  const save = useSaveCountLines(storeId, countId)
  const [edits, setEdits] = useState<CountEdits>({})
  const [state, setState] = useState<SaverState>(SaverStates.SAVED)
  const [error, setError] = useState<unknown>(null)
  const editsRef = useRef<CountEdits>({})
  const inFlight = useRef<Promise<boolean> | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loadedDraft = useRef(false)
  const refused = useRef(false)
  const flushRef = useRef<() => Promise<boolean>>(() => Promise.resolve(true))

  const replaceEdits = useCallback(
    (next: CountEdits): void => {
      editsRef.current = next
      setEdits(next)
      if (userId !== undefined) saveDraft(window.localStorage, userId, countId, next)
    },
    [userId, countId]
  )

  // The draft of an earlier visit, once, when the lines are known: only lines that are on the sheet come back
  useEffect(() => {
    if (lines === undefined || userId === undefined || loadedDraft.current) return
    loadedDraft.current = true
    const draft = onlyLinesOf(
      loadDraft(window.localStorage, userId, countId),
      new Set(lines.map(l => l.id))
    )
    if (Object.keys(draft).length > 0) {
      editsRef.current = draft
      setEdits(draft)
      setState(SaverStates.PENDING)
      // What an earlier visit left is sent now, not when the person types again
      timer.current = setTimeout(() => void flushRef.current(), SAVE_DELAY_MS)
    }
  }, [lines, userId, countId])

  // The count left counting (sent, cancelled, recounted elsewhere): what was typed has no sheet to go to any more, so it
  // is not kept, not warned about and not sent
  const counting = lines !== undefined
  useEffect(() => {
    if (counting || !loadedDraft.current) return
    loadedDraft.current = false
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
    refused.current = false
    editsRef.current = {}
    setEdits({})
    if (userId !== undefined) saveDraft(window.localStorage, userId, countId, {})
    setError(null)
    setState(SaverStates.SAVED)
  }, [counting, userId, countId])

  // What the api confirmed becomes the quantity of the line on the sheet, without reading 2 000 lines again
  const confirm = useCallback(
    (sent: CountEdits): void => {
      queryClient.setQueryData<CountDetailView>(QueryKeys.counts.detail(storeId, countId), old =>
        old === undefined
          ? old
          : {
              ...old,
              lines: old.lines.map(line => {
                const quantity = sent[line.id]
                return quantity === undefined
                  ? line
                  : {
                      ...line,
                      countedQuantity: quantity,
                      variance: quantity === null ? null : quantity - line.expectedQuantity
                    }
              })
            }
      )
    },
    [queryClient, storeId, countId]
  )

  const send = useCallback(async (): Promise<boolean> => {
    const waiting = editsRef.current
    if (Object.keys(waiting).length === 0) {
      setState(SaverStates.SAVED)
      return true
    }
    setState(SaverStates.SAVING)
    try {
      for (const chunk of chunkEdits(waiting, CountLimits.MAX_LINES_PER_UPDATE)) {
        await save.mutateAsync(
          Object.entries(chunk).map(([lineId, countedQuantity]) => ({ lineId, countedQuantity }))
        )
        confirm(chunk)
        // What was typed again while the request was on its way is not the chunk that was confirmed
        replaceEdits(withoutConfirmed(editsRef.current, chunk))
      }
      refused.current = false
      setError(null)
      setState(Object.keys(editsRef.current).length === 0 ? SaverStates.SAVED : SaverStates.PENDING)
      return Object.keys(editsRef.current).length === 0
    } catch (caught) {
      refused.current = !isRetryableSaveError(caught)
      setError(caught)
      setState(refused.current ? SaverStates.REFUSED : SaverStates.OFFLINE)
      return false
    }
  }, [confirm, replaceEdits, save.mutateAsync])

  const flush = useCallback((): Promise<boolean> => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
    // One send at a time: whoever asks while one is on its way gets its answer, and a second pass picks up the rest
    const running = inFlight.current
    const next = (running ?? Promise.resolve(true)).then(() => send())
    inFlight.current = next
    void next.finally(() => {
      if (inFlight.current === next) inFlight.current = null
    })
    return next
  }, [send])
  useEffect(() => {
    flushRef.current = flush
  }, [flush])

  const setQuantity = useCallback(
    (lineId: string, quantity: number | null): void => {
      replaceEdits({ ...editsRef.current, [lineId]: quantity })
      refused.current = false
      setState(current => (current === SaverStates.SAVING ? current : SaverStates.PENDING))
      if (timer.current !== null) clearTimeout(timer.current)
      timer.current = setTimeout(() => void flush(), SAVE_DELAY_MS)
    },
    [flush, replaceEdits]
  )

  // A send that failed for want of a signal: when the phone is back online, and every so often while the page is open
  useEffect(() => {
    if (state !== SaverStates.OFFLINE) return undefined
    const retry = (): void => void flush()
    window.addEventListener('online', retry)
    const interval = setInterval(retry, RETRY_DELAY_MS)
    return () => {
      window.removeEventListener('online', retry)
      clearInterval(interval)
    }
  }, [state, flush])

  // Leaving with quantities the api has not confirmed: the browser asks first (they are also in the draft)
  const unsaved = Object.keys(edits).length > 0
  useEffect(() => {
    if (!unsaved) return undefined
    const warn = (event: BeforeUnloadEvent): void => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [unsaved])

  // Leaving the sheet sends what is waiting, through the same one-at-a-time path (it stays in the draft if that fails too)
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current)
      if (Object.keys(editsRef.current).length > 0) void flushRef.current()
    },
    []
  )

  return { edits, state, error, setQuantity, flush }
}
