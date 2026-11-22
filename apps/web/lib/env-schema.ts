import { z } from 'zod'

// The browser bundle gets its own, much smaller schema. It never imports libs/core/config: that
// would pull server secrets into the client build.
export const webEnvSchema = z.object({
  NEXT_PUBLIC_API_URL: z.url({ protocol: /^https?$/ }),
  // Socket.io accepts the http(s) url of the server or its ws(s) form; both end up in the CSP
  NEXT_PUBLIC_WS_URL: z.url({ protocol: /^(https?|wss?)$/ }),
  // The bucket host the browser uploads to and draws files from (signed urls): it joins the CSP
  NEXT_PUBLIC_STORAGE_URL: z.url({ protocol: /^https?$/ }),
  // The Docker build always sets the variable: an empty one means no key, as an absent one does
  // A key of the wrong shape would fail in the browser (`PushManager.subscribe`), not at build: the public half of a pair
  // from `pnpm vapid:generate` is an uncompressed P-256 point, 65 bytes starting with 0x04, which is 87 base64url
  // characters starting with `B` (the api and the worker check the pair with the same rule, `PushLimits.VAPID_PUBLIC_BYTES`;
  // the web does not import libs/core, so the shape is written as one pattern, small enough for the budget of the inbox)
  NEXT_PUBLIC_VAPID_PUBLIC_KEY: z
    .string()
    .regex(
      /^B[\w-]{86}$/,
      'the public key of a VAPID pair: 87 base64url characters, as `pnpm vapid:generate` prints'
    )
    .optional()
    .or(z.literal('').transform(() => undefined)),
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
