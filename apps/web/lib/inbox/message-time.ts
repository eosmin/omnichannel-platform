// How the time of a message is written. A clock of 24 hours writes the hour with two digits (`00:35`),
// where the short style of some locales drops the zero (`0:35`); a clock of 12 hours keeps its usual
// short style (`9:05 AM`).
type MessageTimeOptions = { hour: '2-digit'; minute: '2-digit' } | { timeStyle: 'short' }

const TWO_DIGITS: MessageTimeOptions = { hour: '2-digit', minute: '2-digit' }
const SHORT: MessageTimeOptions = { timeStyle: 'short' }
// Read once per language: every bubble of a thread asks, at every render
const known = new Map<string, MessageTimeOptions>()

export function messageTimeOptions(locale: string): MessageTimeOptions {
  const cached = known.get(locale)
  if (cached !== undefined) return cached
  const cycle = new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions().hourCycle
  const options = cycle === 'h23' || cycle === 'h24' ? TWO_DIGITS : SHORT
  known.set(locale, options)
  return options
}
