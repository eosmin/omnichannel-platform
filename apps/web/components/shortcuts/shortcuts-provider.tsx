'use client'

import {
  createContext,
  type ReactElement,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef
} from 'react'

import {
  KeyboardOverlayRoles,
  ListKeyAliases,
  SHORTCUT_SEQUENCE_TIMEOUT_MS,
  Shortcuts
} from '@platform/core/domain'

import {
  type ChordState,
  chordOf,
  isShortcutField,
  isTypingTarget,
  nextChord,
  NO_PENDING,
  worksWhileTyping
} from '../../lib/shortcuts/chords'
import {
  type HandlerEntry,
  insertByPriority,
  isMacPlatformName,
  runEntries,
  type ShortcutHandler
} from '../../lib/shortcuts/dispatch'

export type { ShortcutHandler }

type Entry = HandlerEntry

interface ShortcutsValue {
  register: (binding: string, entry: Entry) => () => void
}

const ShortcutsContext = createContext<ShortcutsValue | null>(null)

// Keys that may repeat while held; an action must not run again for each repeat
const REPEATABLE = new Set<string>([
  Shortcuts.list.NEXT_CONVERSATION,
  Shortcuts.list.PREVIOUS_CONVERSATION,
  ListKeyAliases.NEXT_CONVERSATION,
  ListKeyAliases.PREVIOUS_CONVERSATION
])

// Anything open on top of the page owns the keyboard (a dialog, a menu): the page behind it must not
// react to a key meant for it
const OVERLAY_SELECTOR = KeyboardOverlayRoles.map(role => `[role="${role}"]`).join(', ')

// Read once: the platform does not change while the page is open
let isMac: boolean | undefined
function isMacPlatform(): boolean {
  isMac ??= isMacPlatformName(navigator)
  return isMac
}

// One listener on the document for every shortcut of the screen (TDD_09 §9). Components register the
// bindings they handle with `useShortcut`; the provider reads sequences ("g i"), ignores text fields
// and overlays, and runs the handler with the highest priority that takes the key.
export function ShortcutsProvider({ children }: { children: ReactNode }): ReactElement {
  const handlers = useRef(new Map<string, Entry[]>())
  const chordState = useRef<ChordState>(NO_PENDING)

  const value = useMemo<ShortcutsValue>(
    () => ({
      register: (binding, entry) => {
        const list = handlers.current.get(binding) ?? []
        handlers.current.set(binding, insertByPriority(list, entry))
        return () => {
          const rest = (handlers.current.get(binding) ?? []).filter(item => item !== entry)
          if (rest.length === 0) handlers.current.delete(binding)
          else handlers.current.set(binding, rest)
        }
      }
    }),
    []
  )

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // A field or a control that took the key (the composer menu closing on Escape) keeps it
      if (event.defaultPrevented || event.isComposing) return
      const chord = chordOf(event, isMacPlatform())
      if (chord === null) return
      if (document.querySelector(OVERLAY_SELECTOR) !== null) {
        chordState.current = NO_PENDING
        return
      }
      const registered = new Set(handlers.current.keys())
      if (isTypingTarget(event.target)) {
        chordState.current = NO_PENDING
        if (worksWhileTyping(chord) && isShortcutField(event.target) && registered.has(chord)) {
          run(chord, event)
        }
        return
      }
      const outcome = nextChord(
        chord,
        chordState.current,
        event.timeStamp,
        registered,
        SHORTCUT_SEQUENCE_TIMEOUT_MS
      )
      chordState.current = outcome.state
      if (outcome.binding === null) return
      if (event.repeat && !REPEATABLE.has(outcome.binding)) return
      run(outcome.binding, event)
    }

    function run(binding: string, event: KeyboardEvent): void {
      if (runEntries(handlers.current.get(binding) ?? [], event)) event.preventDefault()
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  return <ShortcutsContext.Provider value={value}>{children}</ShortcutsContext.Provider>
}

export interface ShortcutOptions {
  // Off: the binding is not registered at all, so a lower priority handler gets the key
  enabled?: boolean
  priority?: number
}

// Registers a handler for one or more bindings while the component is mounted and `enabled`
export function useShortcut(
  bindings: string | readonly string[],
  handler: ShortcutHandler,
  { enabled = true, priority = 0 }: ShortcutOptions = {}
): void {
  const context = useContext(ShortcutsContext)
  if (context === null) throw new Error('useShortcut needs ShortcutsProvider above it')
  const latest = useRef(handler)
  useEffect(() => {
    latest.current = handler
  })
  const list = typeof bindings === 'string' ? [bindings] : bindings
  const key = list.join('|')
  const { register } = context
  useEffect(() => {
    if (!enabled) return undefined
    const entry: Entry = { priority, handler: latest }
    const unregister = list.map(binding => register(binding, entry))
    return () => unregister.forEach(off => off())
    // `key` stands for `list`, which is a new array each render
  }, [register, key, enabled, priority])
}
