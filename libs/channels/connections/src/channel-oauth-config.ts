// What the login of the channels needs from the environment, read by the module that provides it so that the
// service stays free of it (a unit spec has no DATABASE_URL to parse). `redirectUri` is undefined where the
// login is off (META_OAUTH_REDIRECT_URI unset): every route of the login then answers as if it did not exist.
export abstract class ChannelOAuthConfig {
  abstract readonly redirectUri: string | undefined
  // The public address of the web app, where the callback sends the browser back to
  abstract readonly frontendUrl: string
}
