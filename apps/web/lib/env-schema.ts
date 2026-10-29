import { z } from 'zod'

// The browser bundle gets its own, much smaller schema. It never imports libs/core/config: that
// would pull server secrets into the client build.
export const webEnvSchema = z.object({
  NEXT_PUBLIC_API_URL: z.url({ protocol: /^https?$/ }),
  // Socket.io accepts the http(s) url of the server or its ws(s) form; both end up in the CSP
  NEXT_PUBLIC_WS_URL: z.url({ protocol: /^(https?|wss?)$/ }),
  NEXT_PUBLIC_VAPID_PUBLIC_KEY: z.string().optional(),
  NEXT_PUBLIC_SENTRY_DSN: z.url().optional(),
  NEXT_PUBLIC_WIDGET_SCRIPT_URL: z.url()
})

export type WebEnv = z.infer<typeof webEnvSchema>

export function parseWebEnv(source: Record<string, string | undefined>): WebEnv {
  const result = webEnvSchema.safeParse(source)
  if (!result.success) {
    throw new Error(`Invalid web environment variables:\n${z.prettifyError(result.error)}`)
  }
  return result.data
}
