// The width from which the inbox shows the list and the conversation side by side (`md` of Tailwind).
// Under it the two are screens of a stack and only one shows (TDD_09 §16.4).
export const SIDE_BY_SIDE_MIN_WIDTH_PX = 768

export function isListHiddenByConversation(): boolean {
  return !window.matchMedia(`(min-width: ${SIDE_BY_SIDE_MIN_WIDTH_PX}px)`).matches
}
