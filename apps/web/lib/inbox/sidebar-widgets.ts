// The widgets of the right sidebar (TDD_09 §8): which ones there are, in which order, and which the
// agent hid. The layout is kept per user in the browser (`StorageKeys.SIDEBAR_WIDGETS`).
export const SidebarWidgets = {
  QUICK_ACTIONS: 'quickActions',
  TEAM_STATUS: 'teamStatus',
  UNASSIGNED_QUEUE: 'unassignedQueue'
} as const
export type SidebarWidgetId = (typeof SidebarWidgets)[keyof typeof SidebarWidgets]

export interface SidebarWidgetEntry {
  id: SidebarWidgetId
  isHidden: boolean
}

export type SidebarLayout = readonly SidebarWidgetEntry[]

const KNOWN: readonly SidebarWidgetId[] = Object.values(SidebarWidgets)

export const DEFAULT_SIDEBAR_LAYOUT: SidebarLayout = [
  { id: SidebarWidgets.QUICK_ACTIONS, isHidden: false },
  { id: SidebarWidgets.UNASSIGNED_QUEUE, isHidden: false },
  { id: SidebarWidgets.TEAM_STATUS, isHidden: false }
]

function isWidgetId(value: unknown): value is SidebarWidgetId {
  return KNOWN.some(id => id === value)
}

// What the browser holds may be anything: old, edited by hand or from another version of the page.
// An unknown or repeated widget is dropped, and a widget the stored layout does not know (a newer
// page added it) joins at the end, shown.
export function parseSidebarLayout(raw: string | null): SidebarLayout {
  if (raw === null) return DEFAULT_SIDEBAR_LAYOUT
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return DEFAULT_SIDEBAR_LAYOUT
  }
  if (!Array.isArray(parsed)) return DEFAULT_SIDEBAR_LAYOUT
  const seen = new Set<SidebarWidgetId>()
  const entries: SidebarWidgetEntry[] = []
  for (const item of parsed as unknown[]) {
    if (typeof item !== 'object' || item === null) continue
    const { id, isHidden } = item as { id?: unknown; isHidden?: unknown }
    if (!isWidgetId(id) || seen.has(id)) continue
    seen.add(id)
    entries.push({ id, isHidden: isHidden === true })
  }
  for (const id of KNOWN) {
    if (!seen.has(id)) entries.push({ id, isHidden: false })
  }
  return entries
}

export function moveWidget(
  layout: SidebarLayout,
  id: SidebarWidgetId,
  direction: -1 | 1
): SidebarLayout {
  const from = layout.findIndex(entry => entry.id === id)
  const to = from + direction
  if (from === -1 || to < 0 || to >= layout.length) return layout
  const next = [...layout]
  const [moved] = next.splice(from, 1)
  if (moved !== undefined) next.splice(to, 0, moved)
  return next
}

export function setWidgetHidden(
  layout: SidebarLayout,
  id: SidebarWidgetId,
  isHidden: boolean
): SidebarLayout {
  return layout.map(entry => (entry.id === id ? { ...entry, isHidden } : entry))
}
