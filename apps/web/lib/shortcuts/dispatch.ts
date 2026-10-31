// A handler that answers `false` did not take the key: the next one in priority order is tried, so
// "a" can mean "assign the ticked rows" when something is ticked and "assign this one" when not.
export type ShortcutHandler<Event = KeyboardEvent> = (event: Event) => boolean | void

export interface HandlerEntry<Event = KeyboardEvent> {
  priority: number
  handler: { current: ShortcutHandler<Event> }
}

// Entries of one binding, highest priority first. Same priority keeps the order of registration.
export function insertByPriority<E extends { priority: number }>(
  entries: readonly E[],
  entry: E
): E[] {
  return [...entries, entry].sort((a, b) => b.priority - a.priority)
}

// Runs the handlers in order until one takes the key; true when one did
export function runEntries<Event>(entries: readonly HandlerEntry<Event>[], event: Event): boolean {
  for (const entry of entries) {
    if (entry.handler.current(event) !== false) return true
  }
  return false
}

interface PlatformSource {
  platform?: string
  userAgentData?: { platform?: string }
}

// Cmd is the modifier on Apple platforms (an iPad in desktop mode reports a Mac)
export function isMacPlatformName(source: PlatformSource): boolean {
  const name = source.userAgentData?.platform ?? source.platform ?? ''
  return /mac|iphone|ipad/i.test(name)
}
