import { z } from 'zod'

import { API_PREFIX, ApiRoutes } from '@platform/core/api'
import {
  emptyAsUnset,
  isDeployedEnvironment,
  LOCAL_HOSTNAMES,
  nodeEnvSchema,
  urlOrNull
} from '@platform/core/env-rules'

import { MetaOAuth } from './meta-oauth-constants'

// The variables of the platform's Meta app (WhatsApp Cloud API, Instagram, Messenger). They belong to the plugin: the
// core knows no provider, so this schema is parsed here, from the same source the core's `env` reads
// (`envSource()`), and `scripts/validate-env-example.ts` checks `.env.example` against both.
//
// The app secret Meta issues is 32 characters; the verify token is chosen by the owner
const MIN_META_SECRET_LENGTH = 16

export const metaEnvShape = {
  // Meta (WhatsApp Cloud API, Instagram, Messenger): one app for all three
  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(), // Webhook HMAC + OAuth
  META_WEBHOOK_VERIFY_TOKEN: z.string().optional(),
  // Optional: the secret of a second Meta app that serves Instagram alone (the account of the owner
  // cannot live in the portfolio that owns the main app). Set, it is the only key that signs Instagram's
  // webhooks; unset, the main app's does. The verify token is the same one for both apps.
  META_INSTAGRAM_APP_SECRET: emptyAsUnset,
  // Optional: the address Facebook sends the browser back to after "Connect with Facebook", which is the
  // callback of this api and must be registered, exactly as written, in the app's list of valid OAuth
  // redirect URIs. Set, the button exists (it needs META_APP_ID and META_APP_SECRET); unset, channels are
  // connected with a pasted token only. Checked below.
  META_OAUTH_REDIRECT_URI: emptyAsUnset,
  // Goes into the url of every Graph call, so its shape is checked
  META_GRAPH_API_VERSION: z
    .string()
    .regex(/^v\d+\.\d+$/)
    .default('v23.0'),
  // Only for the e2e suite, which points Facebook's Graph host at a fake one it controls. Every
  // call carries the connection's access token, so a deployed environment refuses it (see below).
  META_GRAPH_ORIGIN: z
    .url({ protocol: /^https?$/ })
    // A path or a trailing slash would break every url built from it
    .transform(value => new URL(value).origin)
    .optional()
}

// NODE_ENV is the core's variable, read here only to tell a laptop from a deployed environment
export const metaEnvSchema = z.object({ NODE_ENV: nodeEnvSchema, ...metaEnvShape }).check(ctx => {
  const env = ctx.value
  const isDeployed = isDeployedEnvironment(env.NODE_ENV)
  if (env.NODE_ENV !== 'test' && env.META_GRAPH_ORIGIN !== undefined) {
    // A host of the operator's choosing would receive the access token of every connection. Only the
    // test environment may name one: any other value of NODE_ENV could be a deployment.
    ctx.issues.push({
      code: 'custom',
      message:
        'META_GRAPH_ORIGIN is for NODE_ENV=test only: any other environment calls Meta itself',
      path: ['META_GRAPH_ORIGIN'],
      input: env.META_GRAPH_ORIGIN
    })
  }
  if (env.META_OAUTH_REDIRECT_URI !== undefined) {
    const fail = (message: string, path: string, input?: string): void => {
      ctx.issues.push({ code: 'custom', message, path: [path], input })
    }
    const redirect = urlOrNull(env.META_OAUTH_REDIRECT_URI)
    const callbackPath = `${API_PREFIX}${ApiRoutes.channels.oauthCallback}`
    if (redirect === null || (redirect.protocol !== 'https:' && redirect.protocol !== 'http:')) {
      fail('META_OAUTH_REDIRECT_URI must be an http or https address', 'META_OAUTH_REDIRECT_URI')
    } else {
      if (
        redirect.pathname !== callbackPath ||
        redirect.search !== '' ||
        redirect.hash !== '' ||
        // Meta compares the string it is sent, and the URL parser lowercases the host, drops a default port and
        // resolves dot segments: only an address already written in that form is the one that was checked
        redirect.href !== env.META_OAUTH_REDIRECT_URI ||
        redirect.username !== '' ||
        redirect.password !== ''
      ) {
        // Meta compares the address with the registered one byte by byte, and the api answers on one path
        fail(
          `META_OAUTH_REDIRECT_URI must be the callback of this api, ${callbackPath}, with no query, fragment or credentials`,
          'META_OAUTH_REDIRECT_URI'
        )
      }
      if (
        isDeployed &&
        (redirect.protocol !== 'https:' || LOCAL_HOSTNAMES.includes(redirect.hostname))
      ) {
        // The browser comes back to it from Facebook with a code that is worth a token
        fail(
          'a deployed environment needs the public https address of the callback in META_OAUTH_REDIRECT_URI',
          'META_OAUTH_REDIRECT_URI'
        )
      }
    }
    if (env.META_APP_ID === undefined || !MetaOAuth.ASSET_ID_PATTERN.test(env.META_APP_ID)) {
      fail('META_OAUTH_REDIRECT_URI needs META_APP_ID, the number of the Meta app', 'META_APP_ID')
    }
    if (env.META_APP_SECRET === undefined || env.META_APP_SECRET.length < MIN_META_SECRET_LENGTH) {
      fail(
        `META_OAUTH_REDIRECT_URI needs META_APP_SECRET (at least ${MIN_META_SECRET_LENGTH} characters) to exchange the code for a token`,
        'META_APP_SECRET'
      )
    }
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
  if (env.META_APP_SECRET !== undefined && env.META_APP_SECRET === env.META_WEBHOOK_VERIFY_TOKEN) {
    // The verify token is shown to Meta in a form; the app secret signs every webhook
    ctx.issues.push({
      code: 'custom',
      message: 'META_WEBHOOK_VERIFY_TOKEN must not be the same value as META_APP_SECRET',
      path: ['META_WEBHOOK_VERIFY_TOKEN'],
      input: env.META_WEBHOOK_VERIFY_TOKEN
    })
  }
  if (env.META_INSTAGRAM_APP_SECRET !== undefined) {
    if (env.META_INSTAGRAM_APP_SECRET.length < MIN_META_SECRET_LENGTH) {
      ctx.issues.push({
        code: 'custom',
        message: `META_INSTAGRAM_APP_SECRET needs at least ${MIN_META_SECRET_LENGTH} characters when it is set`,
        path: ['META_INSTAGRAM_APP_SECRET'],
        input: env.META_INSTAGRAM_APP_SECRET
      })
    }
    if (env.META_INSTAGRAM_APP_SECRET === env.META_APP_SECRET) {
      // Two apps never share a secret: the same value means the main one was copied, and then a leak of
      // either key forges both channels
      ctx.issues.push({
        code: 'custom',
        message: 'META_INSTAGRAM_APP_SECRET must not be the same value as META_APP_SECRET',
        path: ['META_INSTAGRAM_APP_SECRET'],
        input: env.META_INSTAGRAM_APP_SECRET
      })
    }
    if (env.META_INSTAGRAM_APP_SECRET === env.META_WEBHOOK_VERIFY_TOKEN) {
      ctx.issues.push({
        code: 'custom',
        message:
          'META_INSTAGRAM_APP_SECRET must not be the same value as META_WEBHOOK_VERIFY_TOKEN',
        path: ['META_INSTAGRAM_APP_SECRET'],
        input: env.META_INSTAGRAM_APP_SECRET
      })
    }
  }
})

export type MetaEnv = z.infer<typeof metaEnvSchema>

// What the plugin asks the core for: its own variables, and NODE_ENV to tell a laptop from a deployment
export const META_ENV_KEYS: readonly string[] = ['NODE_ENV', ...Object.keys(metaEnvShape)]

export function parseMetaEnv(source: Record<string, string | undefined>): MetaEnv {
  const result = metaEnvSchema.safeParse(source)
  if (!result.success) {
    throw new Error(`Invalid environment variables:\n${z.prettifyError(result.error)}`)
  }
  return result.data
}
