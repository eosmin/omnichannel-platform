import { z } from 'zod'

// Platform-level variables only. Channel credentials are per store and live encrypted in
// ChannelConnection.credentials. Optional variables stay undefined when unset: an empty string
// would fail the url and email validators, so .env.example comments them out.
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  APP_ROLE: z.enum(['api', 'worker']).default('api'),
  PORT: z.coerce.number().default(8080),
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
  JWT_EXPIRES_IN: z.string().default('15m'),
  REFRESH_TOKEN_EXPIRES_IN: z.string().default('7d'),

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
  EMAIL_PROVIDER: z.enum(['resend']).default('resend'),
  RESEND_API_KEY: z.string().optional(),
  RESEND_WEBHOOK_SECRET: z.string().optional(),
  EMAIL_FROM: z.email().default('noreply@platform.local'),
  EMAIL_INBOUND_DOMAIN: z.string().optional(), // e.g. inbound.platform.com, TDD_10 §5.5

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
  META_GRAPH_API_VERSION: z.string().default('v23.0'),

  // Virus scanning
  CLAMAV_HOST: z.string().default('localhost'),
  CLAMAV_PORT: z.coerce.number().default(3310),

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

export type Env = z.infer<typeof envSchema>

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source)
  if (!result.success) {
    throw new Error(`Invalid environment variables:\n${z.prettifyError(result.error)}`)
  }
  return result.data
}
