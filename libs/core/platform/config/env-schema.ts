import { z } from 'zod'

import { DURATION_PATTERN, durationToSeconds } from './duration'

// Platform-level variables only. Channel credentials are per store and live encrypted in
// ChannelConnection.credentials. Optional variables stay undefined when unset: an empty string
// would fail the url and email validators, so .env.example comments them out.
// The placeholder values .env.example ships with. They are fine on a laptop and must never reach
// a deployed environment, where they would protect the channel credentials with a public key.
const PLACEHOLDER_JWT_SECRET_PREFIX = 'change-me'
const PLACEHOLDER_ENCRYPTION_KEY = /^0{64}$/
const MAX_SESSION_MAX_AGE_SECONDS = 365 * 86_400
// The app secret Meta issues is 32 characters; the verify token is chosen by the owner
const MIN_META_SECRET_LENGTH = 16
const DEPLOYED_ENVIRONMENTS: readonly string[] = ['staging', 'production']
const LOCAL_HOSTNAMES: readonly string[] = ['localhost', '127.0.0.1', '[::1]', '0.0.0.0']

// A bare address or "Name <address>", the form providers like Resend accept and customers see.
const SENDER_WITH_NAME = /^([^<>"\r\n]{1,100}?)\s*<([^<>\s]+)>$/
const senderAddress = z.string().refine(value => {
  const trimmed = value.trim()
  const address = SENDER_WITH_NAME.exec(trimmed)?.[2] ?? trimmed
  return z.email().safeParse(address).success
}, 'must be an email address or "Name <email>"')

const duration = (
  fallback: string
): z.ZodPipe<z.ZodDefault<z.ZodString>, z.ZodTransform<number, string>> =>
  z
    .string()
    .regex(DURATION_PATTERN, 'use a number and s, m, h or d (for example 15m)')
    .default(fallback)
    .transform(durationToSeconds)

// The processes of the platform: the api holds the sockets, the worker runs the jobs
export const AppRoles = { API: 'api', WORKER: 'worker' } as const

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    APP_ROLE: z.enum([AppRoles.API, AppRoles.WORKER]).default(AppRoles.API),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    API_URL: z.url(),
    FRONTEND_URL: z.url().default('http://localhost:3000'),
    COMMIT_SHA: z.string().optional(),

    // Database
    DATABASE_URL: z.url(),
    DATABASE_REPLICA_URL: z.url().optional(),

    // Redis
    REDIS_URL: z.url(),
    REDIS_QUEUE_URL: z.url().optional(),

    // Auth: login is a magic link, so there are no passwords and no OAuth credentials
    JWT_SECRET: z.string().min(32),
    // Written as "15m" or "7d", read by the code in seconds
    JWT_EXPIRES_IN: duration('15m'),
    REFRESH_TOKEN_EXPIRES_IN: duration('7d'),
    // How long a login lasts at most, however often its refresh token is used (sliding refresh has
    // no end of its own). Checked below: it cannot be shorter than one refresh token.
    SESSION_MAX_AGE: duration('30d'),
    // Reverse proxies in front of the api whose X-Forwarded-For is trusted (0 = none, the laptop).
    // The rate limits are per client IP, so a wrong value makes every client look like the proxy:
    // a deployed environment must say it (checked below), and the laptop default is applied after.
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).optional(),

    // Encryption at rest for ChannelConnection.credentials and ApiKey secrets (AES-256-GCM)
    CREDENTIALS_ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/), // 32 bytes, hex

    // Storage (S3-compatible; SeaweedFS locally)
    AWS_REGION: z.string().default('us-east-1'),
    AWS_ACCESS_KEY_ID: z.string(),
    AWS_SECRET_ACCESS_KEY: z.string(),
    S3_BUCKET: z.string(),
    S3_ENDPOINT: z.url().optional(), // Local / non-AWS endpoint
    S3_FORCE_PATH_STYLE: z.stringbool().default(false), // true for SeaweedFS

    // Email
    // Resend when RESEND_API_KEY is set, otherwise SMTP (Mailpit) when SMTP_URL is: the key wins, so
    // moving to Resend is only setting it. Deployed environments need the key (see the check below).
    // min(1): "RESEND_API_KEY=" in a file is a mistake, not a key, and must not count as set
    RESEND_API_KEY: z.string().min(1).optional(),
    SMTP_URL: z.url().optional(),
    RESEND_WEBHOOK_SECRET: z.string().min(1).optional(),
    EMAIL_FROM: senderAddress.default('noreply@platform.local'),

    // Observability
    SENTRY_DSN: z.url().optional(),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

    // Push
    VAPID_PUBLIC_KEY: z.string().optional(),
    VAPID_PRIVATE_KEY: z.string().optional(),

    // Meta (WhatsApp Cloud API, Instagram, Messenger): one app for all three
    META_APP_ID: z.string().optional(),
    META_APP_SECRET: z.string().optional(), // Webhook HMAC + OAuth
    META_WEBHOOK_VERIFY_TOKEN: z.string().optional(),
    // Goes into the url of every Graph call, so its shape is checked
    META_GRAPH_API_VERSION: z
      .string()
      .regex(/^v\d+\.\d+$/)
      .default('v23.0'),

    // Virus scanning
    CLAMAV_HOST: z.string().default('localhost'),
    CLAMAV_PORT: z.coerce.number().int().min(1).max(65535).default(3310),

    // Bull Board and the dead-letter tooling: a JWT plus this allowlist (empty = nobody)
    BULL_BOARD_ENABLED: z.stringbool().default(false),
    BULL_BOARD_ADMIN_EMAILS: z
      .string()
      .default('')
      .transform(list =>
        list
          .split(',')
          .map(email => email.trim().toLowerCase())
          .filter(email => email.length > 0)
      )
      .pipe(z.array(z.email())),

    // Read only by the owner bootstrap, which validates that they are present
    SEED_OWNER_EMAIL: z.email().optional(),
    SEED_OWNER_NAME: z.string().optional(),
    SEED_ORGANIZATION_NAME: z.string().optional(),
    SEED_STORE_NAME: z.string().optional()
  })
  .check(ctx => {
    const env = ctx.value
    const isDeployed = DEPLOYED_ENVIRONMENTS.includes(env.NODE_ENV)
    if (env.SESSION_MAX_AGE > MAX_SESSION_MAX_AGE_SECONDS) {
      // Far enough to be no cap at all, and past a point where Date overflows into an invalid date,
      // which would fail every login with an error nobody can read
      ctx.issues.push({
        code: 'custom',
        message: 'SESSION_MAX_AGE cannot be longer than 365 days',
        path: ['SESSION_MAX_AGE'],
        input: env.SESSION_MAX_AGE
      })
    }
    if (env.SESSION_MAX_AGE < env.REFRESH_TOKEN_EXPIRES_IN) {
      ctx.issues.push({
        code: 'custom',
        message: 'SESSION_MAX_AGE cannot be shorter than REFRESH_TOKEN_EXPIRES_IN',
        path: ['SESSION_MAX_AGE'],
        input: env.SESSION_MAX_AGE
      })
    }
    if (env.RESEND_API_KEY === undefined && (isDeployed || env.SMTP_URL === undefined)) {
      // One message, the one that applies: a laptop may use Mailpit, a deployed environment may not
      ctx.issues.push({
        code: 'custom',
        message: isDeployed
          ? 'a deployed environment sends through Resend: RESEND_API_KEY is required'
          : 'set RESEND_API_KEY, or SMTP_URL to send through Mailpit',
        path: ['RESEND_API_KEY'],
        input: env.RESEND_API_KEY
      })
    }
    if (!isDeployed) return
    // Without them the webhook of every Meta channel refuses everything and says nothing
    for (const name of ['META_APP_SECRET', 'META_WEBHOOK_VERIFY_TOKEN'] as const) {
      const value = env[name]
      if (value === undefined || value.length < MIN_META_SECRET_LENGTH) {
        ctx.issues.push({
          code: 'custom',
          message: `a deployed environment needs ${name} (at least ${MIN_META_SECRET_LENGTH} characters) to accept Meta webhooks`,
          path: [name],
          input: value
        })
      }
    }
    if (
      env.META_APP_SECRET !== undefined &&
      env.META_APP_SECRET === env.META_WEBHOOK_VERIFY_TOKEN
    ) {
      // The verify token is shown to Meta in a form; the app secret signs every webhook
      ctx.issues.push({
        code: 'custom',
        message: 'META_WEBHOOK_VERIFY_TOKEN must not be the same value as META_APP_SECRET',
        path: ['META_WEBHOOK_VERIFY_TOKEN'],
        input: env.META_WEBHOOK_VERIFY_TOKEN
      })
    }
    if (env.TRUST_PROXY_HOPS === undefined) {
      // Behind a proxy a missing value is not an error anywhere else: every client would share the
      // address of the proxy, and a handful of logins a minute would lock everybody out
      ctx.issues.push({
        code: 'custom',
        message:
          'a deployed environment must say how many proxies are in front of it: TRUST_PROXY_HOPS (1 on Railway, 0 if the api is reached directly)',
        path: ['TRUST_PROXY_HOPS'],
        input: env.TRUST_PROXY_HOPS
      })
    }
    const frontend = new URL(env.FRONTEND_URL)
    if (frontend.protocol !== 'https:' || LOCAL_HOSTNAMES.includes(frontend.hostname)) {
      // The magic links point there: a link to localhost, or over plain http, is a broken login at best
      ctx.issues.push({
        code: 'custom',
        message: 'a deployed environment needs the public https address of the web app',
        path: ['FRONTEND_URL'],
        input: env.FRONTEND_URL
      })
    }
    if (env.JWT_SECRET.startsWith(PLACEHOLDER_JWT_SECRET_PREFIX)) {
      ctx.issues.push({
        code: 'custom',
        message: 'JWT_SECRET is the .env.example placeholder',
        path: ['JWT_SECRET'],
        input: env.JWT_SECRET
      })
    }
    if (PLACEHOLDER_ENCRYPTION_KEY.test(env.CREDENTIALS_ENCRYPTION_KEY)) {
      ctx.issues.push({
        code: 'custom',
        message: 'CREDENTIALS_ENCRYPTION_KEY is the .env.example placeholder',
        path: ['CREDENTIALS_ENCRYPTION_KEY'],
        input: env.CREDENTIALS_ENCRYPTION_KEY
      })
    }
  })

// TRUST_PROXY_HOPS is optional in the schema (a deployed environment must set it, and the check
// needs to know whether it was); the laptop default is applied here, after the checks
export type Env = Omit<z.infer<typeof envSchema>, 'TRUST_PROXY_HOPS'> & { TRUST_PROXY_HOPS: number }

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source)
  if (!result.success) {
    throw new Error(`Invalid environment variables:\n${z.prettifyError(result.error)}`)
  }
  return { ...result.data, TRUST_PROXY_HOPS: result.data.TRUST_PROXY_HOPS ?? 0 }
}
