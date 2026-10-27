// What the Meta app needs, read from the environment by the module that provides it. The library
// never reads process.env: a missing secret is not an error to boot with, it makes the webhook
// refuse everything.
export abstract class MetaAppConfig {
  abstract readonly appSecret: string | undefined
  abstract readonly verifyToken: string | undefined
  // 'v23.0'
  abstract readonly graphVersion: string
}
