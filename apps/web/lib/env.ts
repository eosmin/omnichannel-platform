import { parseWebEnv } from './env-schema'

// Next.js inlines NEXT_PUBLIC_* only when accessed by full name, hence the explicit object.
export const webEnv = parseWebEnv({
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
  NEXT_PUBLIC_WS_URL: process.env.NEXT_PUBLIC_WS_URL,
  NEXT_PUBLIC_VAPID_PUBLIC_KEY: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
  NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
  NEXT_PUBLIC_WIDGET_SCRIPT_URL: process.env.NEXT_PUBLIC_WIDGET_SCRIPT_URL
})
