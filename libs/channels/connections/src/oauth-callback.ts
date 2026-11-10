import { API_PREFIX, ApiRoutes } from '@platform/core/api'

// The one address a provider's login may send the browser back to: the public origin of this api, the api
// prefix and the callback route. Undefined for something that is not an http(s) origin, so a process that does not
// know its public address has no login to validate against.
export function oauthCallbackUrlOf(apiUrl: string | undefined): string | undefined {
  if (apiUrl === undefined) return undefined
  try {
    const url = new URL(apiUrl)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
    return `${url.origin}${API_PREFIX}${ApiRoutes.channels.oauthCallback}`
  } catch {
    return undefined
  }
}

// Read when the registry is built and not at the top of the file: a unit spec that loads the barrel has no
// environment to parse
export async function oauthCallbackUrl(): Promise<string | undefined> {
  const { envSource } = await import('@platform/core/config/env')
  return oauthCallbackUrlOf(envSource(['API_URL'])['API_URL'])
}
