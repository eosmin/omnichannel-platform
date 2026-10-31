// The keyboard bindings, shared by the help sheet and the handlers (TDD_09 §9). `Mod` is Cmd on
// macOS and Ctrl elsewhere; "g i" is a two-key sequence. Bindings are ignored while a text input
// has focus, except Mod+Enter and Escape.
export const Shortcuts = {
  list: {
    FOCUS_SEARCH: '/',
    NEXT_CONVERSATION: 'j',
    PREVIOUS_CONVERSATION: 'k',
    OPEN_CONVERSATION: 'Enter',
    TOGGLE_SELECTION: 'x',
    SELECT_ALL_VISIBLE: '* a',
    ASSIGN_TO_ME: 'a',
    MARK_RESOLVED: 'e',
    SHOW_HELP: '?'
  },
  conversation: {
    CLOSE: 'Escape',
    FOCUS_REPLY: 'r',
    INTERNAL_NOTE: 'Shift+N',
    ASSIGN_TO_ME: 'a',
    ASSIGN_TO_OTHER: 'Shift+A',
    ADD_TAG: 't',
    MARK_PENDING: 'p',
    MARK_RESOLVED: 'e',
    SNOOZE: 's',
    CREATE_ORDER: 'Shift+O',
    OPEN_CUSTOMER: 'Shift+C'
  },
  global: {
    COMMAND_PALETTE: 'Mod+K',
    SEND_MESSAGE: 'Mod+Enter',
    GO_TO_INBOX: 'g i',
    GO_TO_ORDERS: 'g o',
    GO_TO_CUSTOMERS: 'g c'
  }
} as const

// How a binding is spelled in the table above, read by the handlers and the help sheet.
export const ShortcutSyntax = {
  SEQUENCE_SEPARATOR: ' ',
  COMBINATION_SEPARATOR: '+',
  SHIFT: 'Shift',
  MOD: 'Mod'
} as const

// Keys that are only a modifier: pressing one alone is no binding and must not break a sequence.
export const ModifierOnlyKeys = [
  'Shift',
  'Control',
  'Alt',
  'Meta',
  'AltGraph',
  'CapsLock',
  'Dead'
] as const

// Elements with these roles on top of the page own the keyboard: the shortcuts of the page wait.
export const KeyboardOverlayRoles = ['dialog', 'alertdialog', 'menu'] as const

// The second key of a sequence ("g i", "* a") must come within this time of the first.
export const SHORTCUT_SEQUENCE_TIMEOUT_MS = 1000

// Keys that do what `j` and `k` do in the list (TDD_09 §9 "j or ↓").
export const ListKeyAliases = {
  NEXT_CONVERSATION: 'ArrowDown',
  PREVIOUS_CONVERSATION: 'ArrowUp'
} as const

// The bindings the screen handles today. The help sheet lists only these: search and the palette wait
// for Step 5.1; the jump to orders and `Shift+O` wait for the pages they open.
export const AvailableShortcuts = {
  list: [
    'NEXT_CONVERSATION',
    'PREVIOUS_CONVERSATION',
    'OPEN_CONVERSATION',
    'TOGGLE_SELECTION',
    'SELECT_ALL_VISIBLE',
    'ASSIGN_TO_ME',
    'MARK_RESOLVED',
    'SHOW_HELP'
  ],
  conversation: [
    'CLOSE',
    'FOCUS_REPLY',
    'INTERNAL_NOTE',
    'ASSIGN_TO_ME',
    'ASSIGN_TO_OTHER',
    'ADD_TAG',
    'MARK_PENDING',
    'MARK_RESOLVED',
    'SNOOZE',
    'OPEN_CUSTOMER'
  ],
  global: ['SEND_MESSAGE', 'GO_TO_INBOX', 'GO_TO_CUSTOMERS']
} as const satisfies {
  [Group in keyof typeof Shortcuts]: readonly (keyof (typeof Shortcuts)[Group])[]
}

// The commands of the composer, typed after a `/`. `/product` and `/order` join with
// Step 4.4, which builds products and orders.
export enum SlashCommand {
  SNIPPET = 'snippet',
  ASSIGN = 'assign',
  SNOOZE = 'snooze',
  RESOLVE = 'resolve'
}

export const SLASH_PREFIX = '/'
export const MENTION_PREFIX = '@'
