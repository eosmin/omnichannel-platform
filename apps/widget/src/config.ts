import { WidgetLimits } from '@platform/core/domain'

// What the snippet of the site says, in attributes of the script tag
export interface WidgetOptions {
  siteKey: string
  apiUrl: string
  // `data-locale`, when the site wants a language other than the store's
  locale: string | null
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    // Plain http only for a machine of the developer, as the api demands for a site
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
    return url.protocol === 'https:' || (url.protocol === 'http:' && local)
  } catch {
    return false
  }
}

// Null when the snippet is not usable: the widget then stays out of the page instead of half working
export function readOptions(script: HTMLScriptElement | null): WidgetOptions | null {
  if (script === null) return null
  const siteKey = script.dataset['siteKey']
  const apiUrl = script.dataset['apiUrl']
  if (siteKey === undefined || !siteKey.startsWith(WidgetLimits.SITE_KEY_PREFIX)) return null
  if (apiUrl === undefined || !isHttpUrl(apiUrl)) return null
  return {
    siteKey,
    apiUrl: apiUrl.replace(/\/+$/, ''),
    locale: script.dataset['locale'] ?? null
  }
}
