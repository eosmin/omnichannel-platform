import { ASSET_ID_MAX_LENGTH, parseAssetIdPattern } from '@platform/core/domain'

// What is painted of the name of a linked account: text, cut. It comes from the provider.
const MAX_SHOWN = 80

export interface LocalizedPair {
  readonly es: string
  readonly en: string
}

// A text a plugin declared, in the language of the reader (English for any other)
export function localizedText(text: LocalizedPair, locale: string): string {
  return locale.toLowerCase().startsWith('es') ? text.es : text.en
}

// By characters and not by code units: a name with emoji must not be cut in the middle of one
function cut(value: string): string {
  const characters = Array.from(value)
  return characters.length > MAX_SHOWN ? `${characters.slice(0, MAX_SHOWN).join('')}…` : value
}

// How a linked account is shown: the label of the plugin with `{username}` filled in. The text is painted as
// text, never as markup, and the name is cut.
export function linkedAccountText(label: LocalizedPair, locale: string, username: string): string {
  return localizedText(label, locale).replaceAll('{username}', () => cut(username))
}

// What an id may be when the plugin's pattern is not known (the catalog did not load): one bounded run of plain
// characters. The server checks the id with the plugin's own pattern anyway.
const FALLBACK_ASSET_ID_PATTERN = `^[A-Za-z0-9_-]{1,${ASSET_ID_MAX_LENGTH}}$`

// A test for the id a person types, from the pattern the plugin declared. The descriptor was already checked as
// a pattern that cannot backtrack, and an input over the bound is refused without running it. A pattern the
// browser cannot read accepts nothing; none known falls back to a plain bounded id, so typing is never a dead end.
export function assetIdMatcher(source: string | null): { test: (value: string) => boolean } {
  const pattern = parseAssetIdPattern(source ?? FALLBACK_ASSET_ID_PATTERN)
  return {
    test: value => pattern !== null && value.length <= ASSET_ID_MAX_LENGTH && pattern.test(value)
  }
}
