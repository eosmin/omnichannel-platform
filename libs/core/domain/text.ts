// Half of an emoji: a high surrogate with no low one after it, or a low one with no high one before.
// Cutting text by UTF-16 units can leave one, and Postgres and the engine of Prisma reject it.
export const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

// Postgres refuses a NUL in text and in jsonb, and a lone half of an emoji in jsonb. A provider's text
// is not ours to refuse: the NULs go, a lone surrogate becomes U+FFFD, and the rest is kept.
export const safeText = (text: string): string =>
  text.replaceAll('\0', '').replace(LONE_SURROGATE, '\uFFFD')

// Only what JSON makes: a Buffer or a typed array is not walked byte by byte
function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as unknown
  return prototype === Object.prototype || prototype === null
}

// Whether a text, a list or an object holds a NUL anywhere: in a string, in a key of an object, at any
// depth. Postgres refuses it in text and in jsonb, so it must be told at the edge as a 400, never reach
// the database as a 500 (QA OPS-RD-046, N-4A-05). Walks with a stack, not by recursion: a body of
// 1 MiB can nest deeper than the call stack.
export function containsNul(value: unknown): boolean {
  const pending: unknown[] = [value]
  while (pending.length > 0) {
    const item = pending.pop()
    if (typeof item === 'string') {
      if (item.includes('\0')) return true
    } else if (Array.isArray(item)) {
      for (const inner of item as unknown[]) pending.push(inner)
    } else if (typeof item === 'object' && item !== null && isPlainObject(item)) {
      for (const [key, inner] of Object.entries(item)) {
        if (key.includes('\0')) return true
        pending.push(inner)
      }
    }
  }
  return false
}

// The same walk, for what a provider says and the platform must keep: every string and key goes through
// `safeText`, and the rest of the value is returned as it was. A copy is built with a stack too, so a
// deep payload is no way to make it throw.
export function withoutNul(value: unknown): unknown {
  if (typeof value === 'string') return safeText(value)
  if (
    typeof value !== 'object' ||
    value === null ||
    !(Array.isArray(value) || isPlainObject(value))
  ) {
    return value
  }
  const root: unknown = Array.isArray(value) ? [] : {}
  const stack: [object, object][] = [[value, root as object]]
  while (stack.length > 0) {
    const [source, target] = stack.pop() as [object, object]
    const entries: [string, unknown][] = Array.isArray(source)
      ? (source as unknown[]).map((inner, index) => [String(index), inner])
      : Object.entries(source)
    for (const [key, inner] of entries) {
      let copy: unknown = inner
      if (typeof inner === 'string') copy = safeText(inner)
      else if (
        typeof inner === 'object' &&
        inner !== null &&
        (Array.isArray(inner) || isPlainObject(inner))
      ) {
        copy = Array.isArray(inner) ? [] : {}
        stack.push([inner, copy as object])
      }
      ;(target as Record<string, unknown>)[Array.isArray(target) ? key : safeText(key)] = copy
    }
  }
  return root
}

// An emoji a person left: visible, short, and nothing the database would refuse (a NUL, half of one)
export const isWholeEmoji = (value: string, maxLength: number): boolean =>
  value.trim() !== '' && value.length <= maxLength && safeText(value) === value

// One emoji and nothing else, for what an agent sends to a customer: a pictograph with its optional
// selector and skin tone, a keycap, a flag (two regional indicators, or a black flag with tag letters),
// or up to four of those joined with ZWJ (the longest real sequence joins four). Not a list of the
// sequences that exist: two pictographs joined are accepted. No text, no space, no control or invisible character, no second emoji.
// A regex literal, not `new RegExp`: a call at the top of a module is never dropped by the bundler
const SINGLE_EMOJI =
  /^(?:\u{1F3F4}[\u{E0020}-\u{E007E}]+\u{E007F}|\p{Regional_Indicator}{2}|[0-9#*]️?⃣|\p{Extended_Pictographic}(?:️|(?<=\p{Emoji_Modifier_Base})\p{Emoji_Modifier})?)(?:‍\p{Extended_Pictographic}(?:️|(?<=\p{Emoji_Modifier_Base})\p{Emoji_Modifier})?){0,3}$/u

export const isSingleEmoji = (value: string, maxLength: number): boolean =>
  value.length <= maxLength && SINGLE_EMOJI.test(value)

// The accents of the Latin and Greek letters: the combining marks that "é" splits into. The marks of
// other scripts (the voicing of a Japanese kana, the vowels of Devanagari) change the word and stay.
const LATIN_ACCENTS = /[̀-ͯ]/g
// The format characters that draw nothing (zero-width space, joiners, soft hyphen, byte order mark)
// and the four filler letters that look blank
const INVISIBLE = /[\p{Cf}ᅟᅠㅤﾠ]/gu

// How text is compared when something looks for a word in it: lower case, with no accents, with no
// invisible character (a zero-width space inside "refund" does not hide it) and with every run of
// blanks (a line break, a double space, a non-breaking space) as one space. A text made only of
// accents and invisible characters is empty once plain.
export function plainText(text: string): string {
  return text
    .normalize('NFD')
    .replaceAll(LATIN_ACCENTS, '')
    .replaceAll(INVISIBLE, '')
    .replaceAll(/\s+/g, ' ')
    .toLowerCase()
}

// What makes a NAME misleading when it is drawn in a row of a list (QA TRX-04). The joiners U+200C and
// U+200D are kept where a script or an emoji needs them (Persian spells with the first, a family emoji is
// built with the second); every other invisible format character and the four blank filler letters go,
// together with the braille blank.
const NAME_INVISIBLE = /(?![\u200C\u200D])[\p{Cf}\u115F\u1160\u3164\uFFA0\u2800]/u
const NAME_INVISIBLE_ALL = /(?![\u200C\u200D])[\p{Cf}\u115F\u1160\u3164\uFFA0\u2800]/gu
// A joiner at an end, next to a space or next to another joiner joins nothing and draws nothing
const STRAY_JOINER = /(^|[\s\u200C\u200D])[\u200C\u200D]|[\u200C\u200D](?=$|[\s\u200C\u200D])/u
const STRAY_JOINERS_ALL =
  /(^|\s)[\u200C\u200D]+|[\u200C\u200D]+(?=\s|$)|([\u200C\u200D])[\u200C\u200D]+/gu
// A letter with a pile of combining marks smears over the rows around it (zalgo text)
// Regex literals, not `new RegExp`: a call at the top of a module is never dropped by the bundler, and the
// pages that do not use these rules would carry them
const MARK_RUN = /\p{M}{5,}/u
const MARK_RUN_ALL = /(\p{M}{4})\p{M}+/gu

// True when a name has a line break or other control character, a line or paragraph separator, an
// invisible character, a joiner that joins nothing or a pile of combining marks
export function hasMisleadingCharacters(value: string): boolean {
  return (
    /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value) ||
    NAME_INVISIBLE.test(value) ||
    STRAY_JOINER.test(value) ||
    MARK_RUN.test(value)
  )
}

// A name that a person typed, made one line: every kind of space is a single space, in NFC
export function plainName(value: string): string {
  return value
    .normalize('NFC')
    .replaceAll(/\p{Zs}+/gu, ' ')
    .trim()
}

// The same rules applied by cleaning, for a name a channel reports (the message that carries it must
// still arrive): breaks and spaces become one space, what is invisible goes, the joiners that join
// nothing and the marks over four go. The result is one visible line, or empty.
export function cleanName(raw: string): string {
  return raw
    .replace(LONE_SURROGATE, '')
    .replaceAll('\0', '')
    .replaceAll(NAME_INVISIBLE_ALL, '')
    .replaceAll(/[\p{Cc}\p{Zl}\p{Zp}\p{Zs}]+/gu, ' ')
    .normalize('NFC')
    .replaceAll(MARK_RUN_ALL, '$1')
    .replaceAll(
      STRAY_JOINERS_ALL,
      (_match, edge: string | undefined, kept: string | undefined) => (edge ?? '') + (kept ?? '')
    )
    .trim()
}

// A confirmation phrase typed by a person against the name it asks for (a store being deleted). Space
// around either text is not an error (a name can end in one); the case is, because the phrase is a name
// the person has to read and copy. The screen and the api use this one rule.
export function phraseMatches(typed: string, phrase: string): boolean {
  return typed.trim() === phrase.trim()
}
