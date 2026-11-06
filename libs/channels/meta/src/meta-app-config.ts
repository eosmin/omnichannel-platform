// What the Meta app needs, read from the environment by the module that provides it. The library
// never reads process.env: a missing secret is not an error to boot with, it makes the webhook
// refuse everything.
export abstract class MetaAppConfig {
  abstract readonly appSecret: string | undefined
  // The number of the Meta app, which the login names in its dialog and in the exchange of the code. Unset
  // where the login is off (see META_OAUTH_REDIRECT_URI).
  abstract readonly appId?: string | undefined
  // The secret of a second Meta app that serves Instagram alone. Set, it signs Instagram's webhooks and the
  // main one does not; unset, the main one signs them. The verify token is one for both apps.
  abstract readonly instagramAppSecret?: string | undefined
  abstract readonly verifyToken: string | undefined
  // 'v23.0'
  abstract readonly graphVersion: string
  // Replaces Facebook's Graph host, for a test that serves a fake one. Never set where it is deployed.
  abstract readonly graphOrigin?: string | undefined
}
