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
