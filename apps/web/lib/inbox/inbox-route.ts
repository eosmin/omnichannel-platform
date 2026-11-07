// The inbox (the list, and a conversation open in it) fills the window and the page does not scroll: its
// panes do. The frame of the app asks this of the address, so it is right in the first draw and in every
// browser (a rule on the content that the frame cannot see needs `:has()` and a second pass).
const INBOX_PATH = /^\/s\/[^/]+\/inbox(\/|$)/

export function isInboxPath(pathname: string | null): boolean {
  return pathname !== null && INBOX_PATH.test(pathname)
}
