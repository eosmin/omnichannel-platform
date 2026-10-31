import { ShortcutSyntax } from '@platform/core/domain'

const SEQUENCE_SEPARATOR = ShortcutSyntax.SEQUENCE_SEPARATOR
const COMBINATION_SEPARATOR = ShortcutSyntax.COMBINATION_SEPARATOR

const KEY_NAMES: Record<string, string> = {
  Escape: 'Esc',
  ArrowDown: '↓',
  ArrowUp: '↑'
}

// How the help sheet writes a binding: one list of keys for each step of a sequence. `Mod` is the Cmd
// key on macOS and Ctrl elsewhere, like the handler that reads it.
export function bindingKeys(binding: string, isMac: boolean): string[][] {
  return binding.split(SEQUENCE_SEPARATOR).map(step =>
    step.split(COMBINATION_SEPARATOR).map(key => {
      if (key === ShortcutSyntax.MOD) return isMac ? '⌘' : 'Ctrl'
      return KEY_NAMES[key] ?? key
    })
  )
}
