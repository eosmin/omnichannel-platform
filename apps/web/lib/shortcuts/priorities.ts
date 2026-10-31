// Who gets a key first when several handlers want it ("a" assigns the ticked rows, else the row that
// has the focus, else the open conversation). A handler that does not take the key lets the next one.
export const ShortcutPriority = {
  PAGE: 0,
  OPEN_CONVERSATION: 1,
  FOCUSED_ROW: 2,
  SELECTION: 3
} as const
