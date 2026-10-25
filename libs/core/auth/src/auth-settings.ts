// What the authentication needs from the validated env. The apps get it through AuthPlatformModule
// (libs/core/http); a test provides its own.
export interface AuthSettings {
  jwtSecret: string
  accessTtlSeconds: number
  refreshTtlSeconds: number
  // The web app, where a magic link points
  frontendUrl: string
}

export const AUTH_SETTINGS = Symbol('AUTH_SETTINGS')
