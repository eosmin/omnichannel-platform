export const SettingsLimits = {
  // Lists the composer and the filters load whole: a store has at most this many, so the answer has a size
  MAX_TAGS_PER_STORE: 200,
  MAX_SNIPPETS_PER_STORE: 500,
  TAG_NAME_MAX_LENGTH: 60,
  TAG_DESCRIPTION_MAX_LENGTH: 255,
  SNIPPET_SHORTCUT_MAX_LENGTH: 32,
  SNIPPET_TITLE_MAX_LENGTH: 120,
  // The longest text a WhatsApp message carries
  SNIPPET_CONTENT_MAX_LENGTH: 4096,
  TIMEZONE_MAX_LENGTH: 64,
  MIN_DAYS: 1,
  MAX_DAYS: 365,
  MIN_AGENT_LOAD_THRESHOLD: 1,
  MAX_AGENT_LOAD_THRESHOLD: 100,
  MAX_RANGES_PER_DAY: 4
} as const

// A color the UI draws a tag with: #rrggbb
export const TAG_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/

// The color a tag gets when nobody picks one
export const DEFAULT_TAG_COLOR = '#8b5cf6'

// What a snippet is typed as in the composer: /gracias. Lower-case ASCII letters, digits, dash and
// underscore (other scripts have letters that look like these, and make two shortcuts look alike)
export const SNIPPET_SHORTCUT_PATTERN = /^[a-z0-9_-]+$/

// The days of a business hours schedule, in the order of the week the UI shows
export const Weekdays = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const
export type Weekday = (typeof Weekdays)[number]

// 24-hour clock, HH:mm
export const CLOCK_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/

// The end of a range may be midnight, written 24:00: a store that closes then has no gap of a minute
export const RANGE_END_PATTERN = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/
