// The name the sender carries when the address is bare (the example env, where `Name <address>` cannot
// be written because the file is read by `source` and by `docker --env-file`)
export const DEFAULT_SENDER_NAME = 'Omnichannel Platform'

const HAS_NAME = /<[^<>\s]+>\s*$/

// The `From` of every email: `EMAIL_FROM` as given when it already has a name, otherwise the bare
// address with `EMAIL_FROM_NAME` (or the name of the product) in front. A bare address is shown by mail
// clients as a stranger. The name is checked by the env schema (no quote, backslash, angle bracket, @ or control character).
// Not combined with a sender that has its own name: that one wins, and the name is ignored.
export function senderOf(from: string, name?: string): string {
  const trimmed = from.trim()
  if (HAS_NAME.test(trimmed)) return trimmed
  // Quoted, so that a dot or a parenthesis in the name is not read as part of the header's grammar
  return `"${name?.trim() || DEFAULT_SENDER_NAME}" <${trimmed}>`
}
