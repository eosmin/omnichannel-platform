'use client'

import { useCallback, useMemo, useSyncExternalStore } from 'react'

import { useStore } from '../../components/providers/store-context'
import { useProfile } from '../use-profile'

import {
  DEFAULT_SIDEBAR_LAYOUT,
  moveWidget,
  parseSidebarLayout,
  setWidgetHidden,
  sidebarLayoutKey,
  type SidebarLayout,
  type SidebarWidgetId
} from './sidebar-widgets'

const listeners = new Set<() => void>()

function subscribe(key: string | null, listener: () => void): () => void {
  listeners.add(listener)
  const onStorage = (event: StorageEvent): void => {
    if (event.key === null || event.key === key) listener()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

function readRaw(key: string | null): string | null {
  if (key === null) return null
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null // Storage blocked: the default layout, not kept
  }
}

export interface SidebarLayoutControls {
  layout: SidebarLayout
  move: (id: SidebarWidgetId, direction: -1 | 1) => void
  setHidden: (id: SidebarWidgetId, isHidden: boolean) => void
}

// The order and visibility of the widgets, kept per user and store in the browser and followed across
// tabs. Until the person is known there is nothing to key by: the default layout, and no saving.
export function useSidebarLayout(): SidebarLayoutControls {
  const { storeId } = useStore()
  const userId = useProfile().data?.id
  const key = userId === undefined ? null : sidebarLayoutKey(userId, storeId)
  const subscribeToKey = useCallback((listener: () => void) => subscribe(key, listener), [key])
  const raw = useSyncExternalStore(
    subscribeToKey,
    () => readRaw(key),
    () => null
  )
  const layout = useMemo(
    () => (key === null ? DEFAULT_SIDEBAR_LAYOUT : parseSidebarLayout(raw)),
    [key, raw]
  )

  const save = useCallback(
    (next: SidebarLayout): void => {
      if (key === null) return
      try {
        window.localStorage.setItem(key, JSON.stringify(next))
      } catch {
        return // Storage full or blocked: the change is not kept
      }
      for (const listener of listeners) listener()
    },
    [key]
  )

  const move = useCallback(
    (id: SidebarWidgetId, direction: -1 | 1) =>
      save(moveWidget(parseSidebarLayout(readRaw(key)), id, direction)),
    [save, key]
  )
  const setHidden = useCallback(
    (id: SidebarWidgetId, isHidden: boolean) =>
      save(setWidgetHidden(parseSidebarLayout(readRaw(key)), id, isHidden)),
    [save, key]
  )
  return { layout, move, setHidden }
}
