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
// A link or a scheme written in the text
const LINKISH = /:\/\/|www\.|javascript:|data:/i

// A text a person reads: bounded in characters, trimmed, and plain. Counted as characters, not bytes.
export function isPlainDescriptorText(
  value: unknown,
  max: number = ChannelDescriptorLimits.TEXT_MAX_LENGTH
): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value === value.trim() &&
    Array.from(value).length <= max &&
    !NOT_PLAIN.test(value) &&
    !LINKISH.test(value)
  )
}

// Copies a text in both languages when each is plain; null otherwise. Read once: what is returned is what was checked.
export function readLocalizedText(
  value: unknown,
  max: number = ChannelDescriptorLimits.TEXT_MAX_LENGTH
): LocalizedText | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const { es, en } = value as Record<string, unknown>
  if (!isPlainDescriptorText(es, max) || !isPlainDescriptorText(en, max)) return null
  return Object.freeze({ es, en })
}

// An origin the CSP of the page may name: https, a host in lower case with at least two labels and a real
// top level domain, and at most one wildcard, as the first label (the subdomains of a host). No port, path,
// credentials or address, so it can only widen `img-src` to that host, never to anything else.
const IMAGE_HOST =
  /^https:\/\/(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/
export function isImageHostOrigin(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= ChannelDescriptorLimits.IMAGE_HOST_MAX_LENGTH &&
    IMAGE_HOST.test(value) &&
    // `https://*.com` would be the whole of a top level domain
    !/^https:\/\/\*\.[a-z0-9-]+$/.test(value)
  )
}
