'use client'

import { useCallback, useEffect, useState } from 'react'

import { type OAuthReturn, readOAuthReturn, withoutOAuthParams } from './oauth-return'

const EMPTY: OAuthReturn = { session: null, failure: null }

// What the browser brought back from Facebook (Step 7.8), read once and taken out of the address at once: the id
// of a session must not stay in the history, in a bookmark or in a `Referer`. It then lives only in this state,
// in memory: not in storage, not in a link, not in a log.
export function useOAuthReturn(): OAuthReturn & { clear: () => void } {
  const [found, setFound] = useState<OAuthReturn>(EMPTY)
  useEffect(() => {
    const { pathname, search, hash } = window.location
    const read = readOAuthReturn(search)
    // The parameters go whatever their value was, even one that is not read
    const clean = withoutOAuthParams(pathname, search, hash)
    if (clean !== `${pathname}${search}${hash}`) {
      window.history.replaceState(window.history.state, '', clean)
    }
    // Only when something was found: a second run of the effect (React in development) sees a clean address
    // and must not erase what the first one read
    if (read.session !== null || read.failure !== null) setFound(read)
  }, [])
  const clear = useCallback(() => setFound(EMPTY), [])
  return { ...found, clear }
}
