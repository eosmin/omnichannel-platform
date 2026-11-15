import { PluginWidgetFrames } from '@platform/core/domain'

import {
  decodeCookieValue,
  frameCookieName,
  parseFrameOrigins,
  serializeFrameOrigins
} from './plugin-frames'

// The browser half of `frame-src` per store (see plugin-frames.ts): what the document's own policy allows, written by
// the proxy into a meta tag; the origins a store's widgets need, written as the cookie the proxy reads next time; and
// the one reload that makes a page that needs a new origin load under a policy that has it.

export function documentFrameOrigins(doc: Document): string[] {
  const content = doc
    .querySelector(`meta[name="${PluginWidgetFrames.ORIGINS_META_NAME}"]`)
    ?.getAttribute('content')
  // Already filtered by the proxy; parsed again with no platform origins to drop only what is not an https origin
  return content === null || content === undefined ? [] : parseFrameOrigins(content, [])
}

export function framesAllowed(allowed: readonly string[], needed: readonly string[]): boolean {
  return needed.every(origin => allowed.includes(origin))
}

export function readFrameCookie(doc: Document, storeId: string): string[] {
  const name = `${frameCookieName(storeId)}=`
  const entry = doc.cookie.split('; ').find(part => part.startsWith(name))
  return entry === undefined
    ? []
    : parseFrameOrigins(decodeCookieValue(entry.slice(name.length)), [])
}

// Written for the whole site, Lax, as a plain cookie: the proxy reads it and no script of ours needs it back
export function writeFrameCookie(
  doc: Document,
  storeId: string,
  origins: readonly string[],
  secure: boolean
): void {
  const value = encodeURIComponent(serializeFrameOrigins(origins))
  const attributes = [
    `${frameCookieName(storeId)}=${value}`,
    'Path=/',
    `Max-Age=${origins.length === 0 ? 0 : PluginWidgetFrames.COOKIE_MAX_AGE_SECONDS}`,
    'SameSite=Lax',
    ...(secure ? ['Secure'] : [])
  ]
  doc.cookie = attributes.join('; ')
}

// Reloads once for a set of origins. Where the cookie cannot be set the same set would reload forever, so the attempt
// is remembered for the tab and a second one is refused.
export function shouldReloadFor(
  storage: Pick<Storage, 'getItem' | 'setItem'> | null,
  storeId: string,
  needed: readonly string[]
): boolean {
  const key = `${PluginWidgetFrames.RELOAD_MARK_PREFIX}${storeId}`
  const mark = serializeFrameOrigins([...needed].sort())
  if (storage === null) return false
  try {
    if (storage.getItem(key) === mark) return false
    storage.setItem(key, mark)
  } catch {
    // No storage to remember the attempt in: never reload, a notice says the widget could not load
    return false
  }
  return true
}

// A document whose policy has the origins needs no reload: the mark of an earlier one goes, so that a later change of the
// store's widgets (an uninstall, an expired cookie, a reinstall) can reload again
export function clearReloadMark(
  storage: Pick<Storage, 'removeItem'> | null,
  storeId: string
): void {
  try {
    storage?.removeItem(`${PluginWidgetFrames.RELOAD_MARK_PREFIX}${storeId}`)
  } catch {
    // Nothing remembered, nothing to clear
  }
}
