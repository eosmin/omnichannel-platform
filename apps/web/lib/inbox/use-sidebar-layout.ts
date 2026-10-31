'use client'

import { useCallback, useMemo, useSyncExternalStore } from 'react'

import { StorageKeys } from '@platform/api-client'

import {
  moveWidget,
  parseSidebarLayout,
  setWidgetHidden,
  type SidebarLayout,
  type SidebarWidgetId
} from './sidebar-widgets'

const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  const onStorage = (event: StorageEvent): void => {
    if (event.key === null || event.key === StorageKeys.SIDEBAR_WIDGETS) listener()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

function readRaw(): string | null {
  try {
    return window.localStorage.getItem(StorageKeys.SIDEBAR_WIDGETS)
  } catch {
    return null // Storage blocked: the default layout, not kept
  }
}

export interface SidebarLayoutControls {
  layout: SidebarLayout
  move: (id: SidebarWidgetId, direction: -1 | 1) => void
  setHidden: (id: SidebarWidgetId, isHidden: boolean) => void
}

// The order and visibility of the widgets, kept per user in the browser and followed across tabs
export function useSidebarLayout(): SidebarLayoutControls {
  const raw = useSyncExternalStore(subscribe, readRaw, () => null)
  const layout = useMemo(() => parseSidebarLayout(raw), [raw])

  const save = useCallback((next: SidebarLayout): void => {
    try {
      window.localStorage.setItem(StorageKeys.SIDEBAR_WIDGETS, JSON.stringify(next))
    } catch {
      return // Storage full or blocked: the change is not kept
    }
    for (const listener of listeners) listener()
  }, [])

  const move = useCallback(
    (id: SidebarWidgetId, direction: -1 | 1) =>
      save(moveWidget(parseSidebarLayout(readRaw()), id, direction)),
    [save]
  )
  const setHidden = useCallback(
    (id: SidebarWidgetId, isHidden: boolean) =>
      save(setWidgetHidden(parseSidebarLayout(readRaw()), id, isHidden)),
    [save]
  )
  return { layout, move, setHidden }
}
