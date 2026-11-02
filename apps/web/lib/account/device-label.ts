// A readable name for the browser and system in a user agent, for the list of signed-in devices. It
// is a label for a person to recognise their own device, not a detector: anything it does not know
// gives null and the page shows the text as it came.
const BROWSERS: readonly [RegExp, string][] = [
  [/Edg(?:e|A|iOS)?\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/Firefox\/|FxiOS\//, 'Firefox'],
  [/Chrome\/|CriOS\//, 'Chrome'],
  [/Safari\//, 'Safari']
]

// Order matters: an iPhone user agent also says "like Mac OS X", and Android also says "Linux"
const SYSTEMS: readonly [RegExp, string][] = [
  [/iPhone|iPad|iPod/, 'iOS'],
  [/Android/, 'Android'],
  [/Windows/, 'Windows'],
  [/Macintosh|Mac OS X/, 'macOS'],
  [/CrOS/, 'ChromeOS'],
  [/Linux/, 'Linux']
]

export interface DeviceLabel {
  browser: string
  system: string
}

export function deviceLabel(userAgent: string | null): DeviceLabel | null {
  if (userAgent === null) return null
  const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1]
  const system = SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1]
  return browser === undefined || system === undefined ? null : { browser, system }
}

// The user agent as text when it is not recognised: cut, because a client controls its length
const MAX_RAW_LENGTH = 80
export function rawDeviceText(userAgent: string | null): string | null {
  if (userAgent === null || userAgent.trim() === '') return null
  return userAgent.length > MAX_RAW_LENGTH ? `${userAgent.slice(0, MAX_RAW_LENGTH)}…` : userAgent
}
