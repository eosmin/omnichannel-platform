// The three endpoints of the Next server that keep the refresh token in an httpOnly cookie, so that
// page scripts never see it. They answer the browser from its own origin; everything else goes to
// the api directly (TDD_01 §7, MVP_TRIM_CHECKLIST "Auth build details").
export const SessionRoutes = {
  consume: '/auth/consume', // POST { token }: trades a magic-link token for a session
  refresh: '/auth/refresh', // POST: rotates the cookie, answers a new access token
  logout: '/auth/logout' // POST: revokes the family and clears the cookie
} as const

// Held while the cookie rotates, so that two tabs never present the same refresh token (the api
// revokes the whole family when one is presented twice)
export const REFRESH_LOCK_NAME = 'platform-refresh'
