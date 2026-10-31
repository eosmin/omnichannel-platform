import { ModifierOnlyKeys, ShortcutSyntax, Shortcuts } from '@platform/core/domain'

export interface KeyLike {
  key: string
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
}

const SEQUENCE_SEPARATOR = ShortcutSyntax.SEQUENCE_SEPARATOR
const SHIFT_PREFIX = `${ShortcutSyntax.SHIFT}${ShortcutSyntax.COMBINATION_SEPARATOR}`
const MOD_PREFIX = `${ShortcutSyntax.MOD}${ShortcutSyntax.COMBINATION_SEPARATOR}`
const MODIFIER_ONLY = new Set<string>(ModifierOnlyKeys)
const LETTER = /^[a-z]$/i

// The binding a key press stands for, spelled as in `Shortcuts`: "j", "Shift+N", "Mod+Enter", "?".
// `Mod` is Cmd on macOS and Ctrl elsewhere. A press with the other modifier, or with Alt, is no
// binding (null): the browser and the system own those.
export function chordOf(event: KeyLike, isMac: boolean): string | null {
  if (event.altKey) return null
  // A modifier pressed on its own (between the two keys of a sequence) is not a key press
  if (MODIFIER_ONLY.has(event.key)) return null
  const hasMod = isMac ? event.metaKey : event.ctrlKey
  const hasOtherMod = isMac ? event.ctrlKey : event.metaKey
  if (hasOtherMod) return null
  const { key } = event
  const isLetter = LETTER.test(key)
  const name = isLetter ? key.toUpperCase() : key
  if (hasMod) return `${MOD_PREFIX}${name}`
  // Letters: Shift names a different binding; without it the case of Caps Lock does not matter
  if (isLetter) return event.shiftKey ? `${SHIFT_PREFIX}${name}` : key.toLowerCase()
  // A symbol typed with Shift ("?", "*") is its own character; a named key keeps the Shift
  if (key.length === 1) return key
  return event.shiftKey ? `${SHIFT_PREFIX}${key}` : key
}

// Which key can start a sequence ("g" of "g i"), from the bindings that are registered
export function sequencePrefixes(bindings: Iterable<string>): Set<string> {
  const prefixes = new Set<string>()
  for (const binding of bindings) {
    const [first, second] = binding.split(SEQUENCE_SEPARATOR)
    if (second !== undefined && first !== undefined) prefixes.add(first)
  }
  return prefixes
}

export interface ChordState {
  pending: string | null
  startedAt: number
}

export const NO_PENDING: ChordState = { pending: null, startedAt: 0 }

export interface ChordOutcome {
  // The binding to run, if the press completes one
  binding: string | null
  state: ChordState
}

// Folds one press into the sequence in progress. A press that completes "x y" runs it; otherwise the
// press is a binding by itself, and starts a sequence if it is the first key of one.
export function nextChord(
  chord: string,
  state: ChordState,
  now: number,
  registered: ReadonlySet<string>,
  timeoutMs: number
): ChordOutcome {
  const prefixes = sequencePrefixes(registered)
  const isPending = state.pending !== null && now - state.startedAt <= timeoutMs
  if (isPending) {
    const sequence = `${state.pending}${SEQUENCE_SEPARATOR}${chord}`
    if (registered.has(sequence)) return { binding: sequence, state: NO_PENDING }
  }
  if (prefixes.has(chord)) {
    // The first key of a sequence is not run alone unless it is also a binding by itself
    return {
      binding: registered.has(chord) ? chord : null,
      state: { pending: chord, startedAt: now }
    }
  }
  return { binding: registered.has(chord) ? chord : null, state: NO_PENDING }
}

// Only Escape and Cmd/Ctrl+Enter work while a text field has the focus (TDD_09 §9)
export function worksWhileTyping(binding: string): boolean {
  return binding === Shortcuts.conversation.CLOSE || binding === Shortcuts.global.SEND_MESSAGE
}

// The composer's box carries this attribute: it is the only field where Escape and Cmd/Ctrl+Enter act
export const SHORTCUT_FIELD_ATTRIBUTE = 'data-shortcuts-field'

// Inputs that take no text: a ticked checkbox keeps the focus and the keys must still work
const NON_TEXT_INPUT_TYPES = new Set([
  'checkbox',
  'radio',
  'button',
  'submit',
  'reset',
  'range',
  'file',
  'image',
  'color'
])

export function isTextInputType(type: string): boolean {
  return !NON_TEXT_INPUT_TYPES.has(type.toLowerCase())
}

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target instanceof HTMLInputElement) return isTextInputType(target.type)
  return target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable
}

export function isShortcutField(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.hasAttribute(SHORTCUT_FIELD_ATTRIBUTE)
}
