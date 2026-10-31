import { Shortcuts } from '@platform/core/domain'

import {
  chordOf,
  isTextInputType,
  type KeyLike,
  nextChord,
  NO_PENDING,
  sequencePrefixes,
  worksWhileTyping
} from './chords'

const press = (key: string, init: Partial<KeyLike> = {}): KeyLike => ({
  key,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...init
})

describe('chordOf', () => {
  it('spells a plain letter in lower case, with or without Caps Lock', () => {
    expect(chordOf(press('j'), true)).toBe('j')
    expect(chordOf(press('J'), true)).toBe('j')
  })

  it('names Shift+letter as the binding table does', () => {
    expect(chordOf(press('N', { shiftKey: true }), true)).toBe(Shortcuts.conversation.INTERNAL_NOTE)
    expect(chordOf(press('A', { shiftKey: true }), false)).toBe(
      Shortcuts.conversation.ASSIGN_TO_OTHER
    )
  })

  it('keeps a symbol typed with Shift as the character itself', () => {
    expect(chordOf(press('?', { shiftKey: true }), true)).toBe(Shortcuts.list.SHOW_HELP)
    expect(chordOf(press('*', { shiftKey: true }), true)).toBe('*')
  })

  it('uses Cmd on macOS and Ctrl elsewhere for Mod, and ignores the other one', () => {
    expect(chordOf(press('Enter', { metaKey: true }), true)).toBe(Shortcuts.global.SEND_MESSAGE)
    expect(chordOf(press('Enter', { ctrlKey: true }), false)).toBe(Shortcuts.global.SEND_MESSAGE)
    expect(chordOf(press('k', { ctrlKey: true }), true)).toBeNull()
    expect(chordOf(press('k', { metaKey: true }), false)).toBeNull()
    expect(chordOf(press('k', { metaKey: true }), true)).toBe(Shortcuts.global.COMMAND_PALETTE)
  })

  it('leaves Alt to the system and names the keys without a character', () => {
    expect(chordOf(press('e', { altKey: true }), true)).toBeNull()
    expect(chordOf(press('Escape'), true)).toBe(Shortcuts.conversation.CLOSE)
    expect(chordOf(press('Enter', { shiftKey: true }), true)).toBe('Shift+Enter')
  })
})

describe('nextChord', () => {
  const registered = new Set([
    Shortcuts.list.NEXT_CONVERSATION,
    Shortcuts.global.GO_TO_INBOX,
    Shortcuts.list.SELECT_ALL_VISIBLE,
    Shortcuts.list.ASSIGN_TO_ME
  ])
  const timeout = 1000

  it('runs a single key at once', () => {
    expect(nextChord('j', NO_PENDING, 0, registered, timeout).binding).toBe('j')
  })

  it('waits after the first key of a sequence and runs it on the second', () => {
    const first = nextChord('g', NO_PENDING, 0, registered, timeout)
    expect(first.binding).toBeNull()
    expect(nextChord('i', first.state, 500, registered, timeout).binding).toBe('g i')
  })

  it('lets a key that is a sequence start and also a binding of its own run (a after *)', () => {
    const first = nextChord('*', NO_PENDING, 0, registered, timeout)
    expect(nextChord('a', first.state, 100, registered, timeout).binding).toBe('* a')
    // Without the star, `a` is assign to me
    expect(nextChord('a', NO_PENDING, 100, registered, timeout).binding).toBe('a')
  })

  it('drops a sequence whose second key came late or is another key', () => {
    const first = nextChord('g', NO_PENDING, 0, registered, timeout)
    expect(nextChord('i', first.state, 1001, registered, timeout).binding).toBeNull()
    expect(nextChord('j', first.state, 10, registered, timeout).binding).toBe('j')
  })

  it('ignores a key nothing is bound to', () => {
    const outcome = nextChord('z', NO_PENDING, 0, registered, timeout)
    expect(outcome.binding).toBeNull()
    expect(outcome.state).toBe(NO_PENDING)
  })
})

describe('sequencePrefixes', () => {
  it('lists the first key of each sequence only', () => {
    expect([...sequencePrefixes(['j', 'g i', 'g o', '* a'])].sort()).toEqual(['*', 'g'])
  })
})

describe('worksWhileTyping', () => {
  it('allows Escape and Mod+Enter only', () => {
    expect(worksWhileTyping(Shortcuts.conversation.CLOSE)).toBe(true)
    expect(worksWhileTyping(Shortcuts.global.SEND_MESSAGE)).toBe(true)
    expect(worksWhileTyping('j')).toBe(false)
    expect(worksWhileTyping(Shortcuts.conversation.INTERNAL_NOTE)).toBe(false)
  })
})

describe('modifier-only presses', () => {
  it('are no chord, so they do not break a sequence', () => {
    for (const key of ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Dead']) {
      expect(chordOf(press(key, { shiftKey: key === 'Shift' }), true)).toBeNull()
    }
  })
})

describe('isTextInputType', () => {
  it('counts text-like inputs only, not a checkbox that keeps the focus after a click', () => {
    expect(isTextInputType('text')).toBe(true)
    expect(isTextInputType('search')).toBe(true)
    expect(isTextInputType('checkbox')).toBe(false)
    expect(isTextInputType('radio')).toBe(false)
    expect(isTextInputType('submit')).toBe(false)
  })
})
