import { ErrorCodes, HttpStatusCodes } from '@platform/core/errors'

import { ApiError } from './api-error'
import { type AccessSession, accessSessionSchema, errorResponseSchema } from './api-schemas'
import { REFRESH_LOCK_NAME, SessionRoutes } from './session-routes'

export interface BrowserSession {
  getAccessToken: () => string | null
  // One refresh at a time, in this tab and across tabs. Throws an ApiError 401 when there is no
  // valid session (no cookie, a revoked or expired family).
  refresh: () => Promise<string>
  consume: (token: string) => Promise<AccessSession>
  logout: () => Promise<void>
  // Called when a refresh finds that the session is gone; returns the way to stop listening
  onSessionLost: (listener: () => void) => () => void
}

export interface BrowserSessionOptions {
  fetchImpl?: typeof fetch
  // navigator.locks; absent in old browsers and in tests, where the tab-level single flight remains
  locks?: { request: (name: string, work: () => Promise<string>) => Promise<string> }
}

async function readError(response: Response): Promise<ApiError> {
  const parsed = errorResponseSchema.safeParse(await response.json().catch(() => null))
  return parsed.success
    ? ApiError.fromBody(response.status, parsed.data)
    : ApiError.unreadable(response.status)
}

// The access token lives in memory only (15 minutes): a reload asks for a new one with the cookie
export function createBrowserSession({
  fetchImpl = fetch,
  locks = typeof navigator === 'undefined' ? undefined : navigator.locks
}: BrowserSessionOptions = {}): BrowserSession {
  let accessToken: string | null = null
  let inflight: Promise<string> | null = null
  const listeners = new Set<() => void>()

  const post = async (path: string, body?: unknown): Promise<Response> => {
    try {
      return await fetchImpl(path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
      })
    } catch {
      throw new ApiError(0, ErrorCodes.INTERNAL_ERROR, 'The server cannot be reached')
    }
  }

  const rotate = async (): Promise<string> => {
    const response = await post(SessionRoutes.refresh)
    if (!response.ok) {
      if (response.status === HttpStatusCodes.UNAUTHORIZED) {
        // Only a session that was live is "lost"; a page that opens with no session (the login, an
        // invitation) just finds out that there is none, and decides for itself
        const wasLive = accessToken !== null
        accessToken = null
        if (wasLive) listeners.forEach(listener => listener())
      }
      throw await readError(response)
    }
    accessToken = accessSessionSchema.parse(await response.json()).accessToken
    return accessToken
  }

  const rotateLocked = (): Promise<string> => {
    if (inflight !== null) return inflight
    const run = locks === undefined ? rotate() : locks.request(REFRESH_LOCK_NAME, rotate)
    inflight = run.finally(() => {
      inflight = null
    })
    return inflight
  }

  return {
    getAccessToken: () => accessToken,
    refresh: rotateLocked,
    consume: async token => {
      const response = await post(SessionRoutes.consume, { token })
      if (!response.ok) throw await readError(response)
      const session = accessSessionSchema.parse(await response.json())
      accessToken = session.accessToken
      return session
    },
    logout: async () => {
      const response = await post(SessionRoutes.logout)
      // Only a logout that went through ends the session here; on a failure the person stays signed
      // in (the cookie may still be there) and is told so
      if (!response.ok) throw await readError(response)
      accessToken = null
    },
    onSessionLost: listener => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}
