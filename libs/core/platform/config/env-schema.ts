import { isIP } from 'node:net'

import { z } from 'zod'

import { E2eMagicLinkLimit } from '@platform/core/auth'
import {
  emptyAsUnset,
  isDeployedEnvironment,
  LOCAL_HOSTNAMES,
  nodeEnvSchema
} from '@platform/core/env-rules'
import { isBase64UrlOfBytes, PushLimits } from '@platform/core/notifications'

import { DURATION_PATTERN, durationToSeconds } from './duration'

// Whether a host is on a private network: parsed, never matched by prefix ("10.example.com" and "127.0.0.1.nip.io" are public names). An IPv4
// address is private in the ranges of RFC 1918 and the loopback; an IPv6 one only for the loopback, the unique local (fc00::/7) and the link
// local (fe80::/10); a name is private when it has no dot (a container), or ends in `.internal` or `.local`, or is a local hostname.
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '')
  const kind = isIP(host)
  if (kind === 4) {
    const [a = 0, b = 0] = host.split('.').map(Number)
    // The loopback, RFC 1918 and the link-local range (169.254/16, like fe80::/10 in IPv6); 0.0.0.0 is no address of a service
    return (
      a === 127 ||
      a === 10 ||
      (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 169 && b === 254)
    )
  }
  if (kind === 6) {
    const lower = host.toLowerCase()
    return lower === '::1' || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower)
  }
  return !host.includes('.') || host.endsWith('.internal') || host.endsWith('.local')
}

// Platform-level variables only. Channel credentials are per store and live encrypted in
// ChannelConnection.credentials. Optional variables stay undefined when unset: an empty string
// would fail the url and email validators, so .env.example comments them out.
// The placeholder values .env.example ships with. They are fine on a laptop and must never reach
// a deployed environment, where they would protect the channel credentials with a public key.
const PLACEHOLDER_JWT_SECRET_PREFIX = 'change-me'
const PLACEHOLDER_ENCRYPTION_KEY = /^0{64}$/
const MAX_SESSION_MAX_AGE_SECONDS = 365 * 86_400
// A bare address or "Name <address>", the form providers like Resend accept and customers see.
const SENDER_WITH_NAME = /^([^<>"\r\n]{1,100}?)\s*<([^<>\s]+)>$/
const senderAddress = z.string().refine(value => {
  const trimmed = value.trim()
  const address = SENDER_WITH_NAME.exec(trimmed)?.[2] ?? trimmed
  return z.email().safeParse(address).success
}, 'must be an email address or "Name <email>"')

// A display name that is safe inside quotes in a header (`senderOf` quotes it): no quote, backslash,
// angle bracket, @ (it would read as an address) or control character
const senderName = z
  .string()
  .trim()
  .min(1)
  .max(70)
  .regex(/^[^<>"\\@\p{Cc}]+$/u, 'a name with no < > " @ \\ or control characters')

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
    NODE_ENV: nodeEnvSchema,
    APP_ROLE: z.enum([AppRoles.API, AppRoles.WORKER]).default(AppRoles.API),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    API_URL: z.url(),
    FRONTEND_URL: z.url().default('http://localhost:3000'),
    // Where the built widget script is served from: the snippet of a store points at it
    WIDGET_SCRIPT_URL: z.url().default('http://localhost:4173/widget.js'),
    COMMIT_SHA: z.string().optional(),

    // Database
    DATABASE_URL: z.url(),
    DATABASE_REPLICA_URL: z.url().optional(),

    // The signing service some fiscal providers need (an application of the tax authority's own, which holds the certificate and runs only on a
    // private network): its address. Without it a provider that needs one is not offered. No credentials in the address.
    // A blank variable (a compose file that passes it through) is the same as none
    FISCAL_SIGNER_URL: z.preprocess(
      value => (value === '' ? undefined : value),
      z
        .url()
        .refine(
          value => {
            try {
              const parsed = new URL(value)
              return (
                (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
                parsed.username === '' &&
                parsed.password === ''
              )
            } catch {
              return false
            }
          },
          { message: 'an http or https address with no credentials' }
        )
        .optional()
    ),

    // Redis
    REDIS_URL: z.url(),
    REDIS_QUEUE_URL: z.url().optional(),
    // Namespaces the queue keys in Redis. Two stacks that share one Redis and have different databases
    // MUST differ here, or each worker takes the jobs of the other (BullMQ defaults to "bull").
    QUEUE_PREFIX: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,32}$/)
      .optional(),

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
    EMAIL_FROM: senderAddress.default('Omnichannel Platform <noreply@platform.local>'),
    // The name shown with a bare EMAIL_FROM (ignored when EMAIL_FROM has its own): a value that
    // `source` and `docker --env-file` read without quotes cannot hold the `Name <address>` form
    EMAIL_FROM_NAME: senderName.optional(),

    // Observability
    SENTRY_DSN: z.url().optional(),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

    // Push
    VAPID_PUBLIC_KEY: emptyAsUnset,
    VAPID_PRIVATE_KEY: emptyAsUnset,

    // Virus scanning
    CLAMAV_HOST: z.string().default('localhost'),
    CLAMAV_PORT: z.coerce.number().int().min(1).max(65535).default(3310),

    // Several files in one message to a customer (each channel declares how many it takes). Off until the
    // interface offers it and a real test with the providers passes: with it off a message carries one file.
    OUTBOUND_MULTI_FILE_ENABLED: z.stringbool().default(false),

    // The limit of magic links per address, raised for the browser suite alone: a number between the real limit
    // and a bound, never "no limit". A deployed or development environment refuses it (checked below); the limit
    // of the code stays the one every other environment runs with.
    E2E_MAGIC_LINK_LIMIT: z.preprocess(
      value => (value === '' ? undefined : value),
      z.coerce.number().int().min(E2eMagicLinkLimit.min).max(E2eMagicLinkLimit.max).optional()
    ),

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
    const isDeployed = isDeployedEnvironment(env.NODE_ENV)
    if (env.NODE_ENV !== 'test' && env.E2E_MAGIC_LINK_LIMIT !== undefined) {
      // A looser limit would let anyone mail-bomb an address from many IPs
      ctx.issues.push({
        code: 'custom',
        message:
          'E2E_MAGIC_LINK_LIMIT is for NODE_ENV=test only: any other environment keeps the real limit',
        path: ['E2E_MAGIC_LINK_LIMIT'],
        input: env.E2E_MAGIC_LINK_LIMIT
      })
    }
    if (env.E2E_MAGIC_LINK_LIMIT !== undefined && env.RESEND_API_KEY !== undefined) {
      // NODE_ENV=test is also what a copy of the CI settings carries: a real mail transport means real inboxes
      ctx.issues.push({
        code: 'custom',
        message:
          'E2E_MAGIC_LINK_LIMIT cannot be set where mail is really sent (RESEND_API_KEY is set)',
        path: ['E2E_MAGIC_LINK_LIMIT'],
        input: env.E2E_MAGIC_LINK_LIMIT
      })
    }
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
    // One key without the other: the push would be off with nothing saying why
    if ((env.VAPID_PUBLIC_KEY === undefined) !== (env.VAPID_PRIVATE_KEY === undefined)) {
      ctx.issues.push({
        code: 'custom',
        message: 'VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are set together or not at all',
        path: ['VAPID_PRIVATE_KEY'],
        input: env.VAPID_PRIVATE_KEY
      })
    }
    if (
      env.VAPID_PUBLIC_KEY !== undefined &&
      env.VAPID_PRIVATE_KEY !== undefined &&
      !(
        isBase64UrlOfBytes(env.VAPID_PUBLIC_KEY, PushLimits.VAPID_PUBLIC_BYTES) &&
        isBase64UrlOfBytes(env.VAPID_PRIVATE_KEY, PushLimits.VAPID_PRIVATE_BYTES)
      )
    ) {
      ctx.issues.push({
        code: 'custom',
        message: 'the VAPID keys must be a pair made by web-push generate-vapid-keys',
        path: ['VAPID_PRIVATE_KEY'],
        input: env.VAPID_PRIVATE_KEY
      })
    }
    if (!isDeployed) return
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
    // The signing service holds no authentication and receives the password of a private key: over plain http it may be only on a private
    // network (a loopback or private address, a name with no dot as a container has, or `.internal` / `.local`); otherwise https
    if (env.FISCAL_SIGNER_URL !== undefined) {
      const signer = new URL(env.FISCAL_SIGNER_URL)
      if (signer.protocol === 'http:' && !isPrivateHost(signer.hostname)) {
        ctx.issues.push({
          code: 'custom',
          message:
            'a deployed environment reaches the signing service over https, or over http only on a private network',
          path: ['FISCAL_SIGNER_URL'],
          input: env.FISCAL_SIGNER_URL
        })
      }
      // A fiscal provider that can send documents but not yet invalidate them must not issue real ones (Step 4B.7c-4 builds the invalidation)
      if (env.NODE_ENV === 'production') {
        ctx.issues.push({
          code: 'custom',
          message:
            'the fiscal signing service is not allowed in production until the invalidation of documents is built (Step 4B.7c-4)',
          path: ['FISCAL_SIGNER_URL'],
          input: env.FISCAL_SIGNER_URL
        })
      }
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
    const widgetScript = new URL(env.WIDGET_SCRIPT_URL)
    if (widgetScript.protocol !== 'https:' || LOCAL_HOSTNAMES.includes(widgetScript.hostname)) {
      // The snippet of every store points there: a script on localhost, or over plain http (blocked on
      // an https site), is a widget that never loads
      ctx.issues.push({
        code: 'custom',
        message: 'a deployed environment needs the public https address of the widget script',
        path: ['WIDGET_SCRIPT_URL'],
        input: env.WIDGET_SCRIPT_URL
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
