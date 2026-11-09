// What a channel plugin declares about itself so that the web and the api draw it with no channel named in
// them (TDD_10 §6.7.2). A third party writes it, so every part is held to a shape: the registry checks it at
// boot and the browser checks it again before it draws anything.

// A text the plugin gives in each language the interface speaks. Text only: never markup, a link or a placeholder.
export interface LocalizedText {
  readonly es: string
  readonly en: string
}

export const ChannelDescriptorLimits = {
  // A name or a label
  TEXT_MAX_LENGTH: 80,
  // A step the owner takes at the provider
  HELP_MAX_LENGTH: 300,
  MAX_HELP_STEPS: 6,
  MAX_IMAGE_HOSTS: 8,
  IMAGE_HOST_MAX_LENGTH: 100
} as const

// The icons a plugin may ask for, by a name of the icon set the interface already ships. Anything else is the
// generic one: a plugin cannot bring a picture, a path or markup.
export const ChannelIconKeys = {
  MESSAGE_SQUARE: 'message-square',
  MESSAGE_CIRCLE: 'message-circle',
  PHONE: 'phone',
  CAMERA: 'camera',
  GLOBE: 'globe',
  MAIL: 'mail',
  SEND: 'send',
  STORE: 'store'
} as const
export type ChannelIconKey = (typeof ChannelIconKeys)[keyof typeof ChannelIconKeys]
export const DEFAULT_CHANNEL_ICON_KEY: ChannelIconKey = ChannelIconKeys.MESSAGE_SQUARE
const ICON_KEYS: ReadonlySet<unknown> = new Set(Object.values(ChannelIconKeys))
export function isChannelIconKey(value: unknown): value is ChannelIconKey {
  return ICON_KEYS.has(value)
}

// The page a channel may have in its settings besides the form of its connection
export const ChannelManagementSurfaces = {
  EMBED_SNIPPET: 'embed_snippet'
} as const
export type ChannelManagementSurface =
  (typeof ChannelManagementSurfaces)[keyof typeof ChannelManagementSurfaces]
const SURFACES: ReadonlySet<unknown> = new Set(Object.values(ChannelManagementSurfaces))
export function isChannelManagementSurface(value: unknown): value is ChannelManagementSurface {
  return SURFACES.has(value)
}

// The hosts the browser may load a picture from for this channel: the avatars of its customers and the
// media it shows in a message (the thumbnail of a story). Each is an origin of its own, https only.
export interface ChannelImageHosts {
  readonly avatar: readonly string[]
  readonly media: readonly string[]
}

// Characters that make a text more than text: markup, a placeholder, an escape, a control or format character
// (a line break, a zero-width joiner)
const NOT_PLAIN = /[<>&`[\]{}\\|]|\p{C}/u
// Blank-looking characters that are not control or format characters: no-break and wide spaces, the line and
// paragraph separators, the braille blank, the Hangul fillers. Only the plain space may separate words.
const LOOKS_BLANK =
  /[\u00a0\u1680\u180e\u2000-\u200a\u2028\u2029\u202f\u205f\u2800\u3000\u3164\u115f\u1160\uffa0]/
// A link, a scheme or an address written in the text: `://`, `www.`, a scheme that runs code or opens an app, and a
// domain written bare (`evil.com/login`, a word, a dot and a top level domain with no space between)
const LINKISH =
  /:\/\/|www\.|(?:javascript|vbscript|data|mailto|tel|sms|file|blob):|\b[a-z0-9-]+\.[a-z]{2,}\b/i
// Something a person can read: at least one letter or digit
const HAS_TEXT = /[\p{L}\p{N}]/u

// A text a person reads: bounded in characters, trimmed, and plain. Counted as characters, not bytes.
export function isPlainDescriptorText(
  value: unknown,
  max: number = ChannelDescriptorLimits.TEXT_MAX_LENGTH,
  placeholders: readonly string[] = []
): value is string {
  // A closed list of placeholders the page fills in (`{username}`): each is replaced by a letter before the text is
  // judged, so any other brace is still refused, a space beside a placeholder still counts as a space in the text,
  // and the length and the trimming are those of the text as written
  if (typeof value === 'string' && placeholders.length > 0) {
    // The cheap bound first, as for any text: nothing is split or scanned that is far over the limit
    if (value.length > max * 2) return false
    const filled = placeholders.reduce((text, name) => text.split(`{${name}}`).join('x'), value)
    if (filled !== value) {
      // A name the page fills in must not complete a link or a scheme (`go.{username}`, `javascript{username}:`):
      // no dot, colon or slash right before it, and none right after it that is followed by more text (a full stop or
      // a colon that ends the sentence is just punctuation). At most twice.
      const joinsALink = placeholders.some(
        name =>
          value.includes(`.{${name}}`) ||
          value.includes(`:{${name}}`) ||
          value.includes(`/{${name}}`) ||
          [`{${name}}.`, `{${name}}:`, `{${name}}/`].some(joined => {
            const at = value.indexOf(joined)
            const after = at === -1 ? '' : value.slice(at + joined.length, at + joined.length + 1)
            return at !== -1 && after !== '' && after !== ' '
          })
      )
      const repeats = placeholders.some(name => value.split(`{${name}}`).length - 1 > 2)
      return (
        !joinsALink &&
        !repeats &&
        Array.from(value).length <= max &&
        isPlainDescriptorText(filled, Number.MAX_SAFE_INTEGER)
      )
    }
  }
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    // The cheap bound first: a code point is at most two UTF-16 units, so this never refuses a valid text, and
    // a huge string is turned away before anything is allocated or scanned
    value.length <= max * 2 &&
    value === value.trim() &&
    Array.from(value).length <= max &&
    !NOT_PLAIN.test(value) &&
    !LOOKS_BLANK.test(value) &&
    HAS_TEXT.test(value) &&
    !LINKISH.test(value)
  )
}

// Copies a text in both languages when each is plain; null otherwise. Read once: what is returned is what was checked.
export function readLocalizedText(
  value: unknown,
  max: number = ChannelDescriptorLimits.TEXT_MAX_LENGTH,
  placeholders: readonly string[] = []
): LocalizedText | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const { es, en } = value as Record<string, unknown>
  if (
    !isPlainDescriptorText(es, max, placeholders) ||
    !isPlainDescriptorText(en, max, placeholders)
  ) {
    return null
  }
  return Object.freeze({ es, en })
}

// An origin the CSP of the page may name: https, a host in lower case with at least two labels and a real
// top level domain. A wildcard (the subdomains of a host, as the first label) only where the caller says so: the
// registry says so for the official plugins alone, because a wildcard on a host that many tenants share
// (`*.github.io`, `*.s3.amazonaws.com`) would let any of them load pictures into the inbox, and there is no list
// of such hosts to check against. No port, path,
// credentials or address, so it can only widen `img-src` to that host, never to anything else.
const IMAGE_HOST =
  /^https:\/\/(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/
// Names that are not on the internet: an address of a private network is never a place to load a picture from
const PRIVATE_TLDS = new Set([
  'local',
  'internal',
  'localhost',
  'localdomain',
  'lan',
  'corp',
  'home',
  'intranet',
  'private',
  'invalid',
  'arpa',
  'onion'
])
export function isImageHostOrigin(value: unknown, { wildcard = false } = {}): value is string {
  if (typeof value !== 'string') return false
  if (!wildcard && value.startsWith('https://*.')) return false
  const tld = value.slice(value.lastIndexOf('.') + 1)
  if (PRIVATE_TLDS.has(tld)) return false
  return (
    value.length <= ChannelDescriptorLimits.IMAGE_HOST_MAX_LENGTH &&
    IMAGE_HOST.test(value) &&
    // `https://*.com` would be the whole of a top level domain
    !/^https:\/\/\*\.[a-z0-9-]+$/.test(value)
  )
}

// The address of the dialog a login sends a person to: the origin of the provider's site, https, exactly: no
// path, query, credentials, port or wildcard, so the browser is only ever sent to that one site and to
// nothing a plugin can steer with a string.
export function isDialogOrigin(value: unknown): value is string {
  return isImageHostOrigin(value)
}

// The id of an account of the provider, as a pattern. A third party writes it and the api and the browser run it
// on what a person types, so it is NOT an arbitrary regular expression (one with nested quantifiers backtracks
// for ever): it is one run of one class of character with a bound, anchored, which cannot backtrack. Returns the
// compiled pattern, or null when the text is anything else.
const ASSET_ID_PATTERN_SOURCE =
  /^\^(\\d|\\w|\[(?:[0-9]-[0-9]|[a-z]-[a-z]|[A-Z]-[A-Z]|[A-Za-z0-9_])+-?\])\{(\d{1,2})(?:,(\d{1,2}))?\}\$$/
export const ASSET_ID_MAX_LENGTH = 64
export function parseAssetIdPattern(source: unknown): RegExp | null {
  if (typeof source !== 'string' || source.length > 60) return null
  const match = ASSET_ID_PATTERN_SOURCE.exec(source)
  if (match === null) return null
  const min = Number(match[2])
  const max = match[3] === undefined ? min : Number(match[3])
  // At least one character (an empty id is no id) and a bound that is short
  if (min < 1 || max < min || max > ASSET_ID_MAX_LENGTH) return null
  try {
    return new RegExp(source)
  } catch {
    return null
  }
}

// What a login declares for the page to draw it: the provider's name, the account it links (the Instagram
// account of a Page) and how to tell an id
export interface ChannelOAuthLinkedAccount {
  // The account is needed: a choice without it cannot be connected
  readonly required: boolean
  // How the linked account is shown, with `{username}` where its name goes
  readonly label: LocalizedText
  // What is shown when the choice has none
  readonly missingLabel: LocalizedText
}
export interface ChannelOAuthDescriptor {
  readonly dialogOrigin: string
  readonly providerName: LocalizedText
  readonly linkedAccount: ChannelOAuthLinkedAccount | null
  readonly assetIdPattern: string
}
export const LINKED_ACCOUNT_PLACEHOLDERS: readonly string[] = ['username']
