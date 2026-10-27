// Text that came from a provider or a plugin, made safe to keep and show: one line, no control
// or invisible ones that mislead (a right-to-left override can reorder a message, a zero-width space
// hides), cut to a size. The joiners (U+200C, U+200D) stay: names in several scripts and emoji need them. It says what went wrong; it is never trusted as markup or as a command.
export function providerText(text: string, max: number): string {
  const clean = text
    .replace(/[\p{Cc}\p{Zl}\p{Zp}\u200B\u200E\u200F\u202A-\u202E\u2060-\u2069\uFEFF]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return Array.from(clean).slice(0, max).join('')
}
