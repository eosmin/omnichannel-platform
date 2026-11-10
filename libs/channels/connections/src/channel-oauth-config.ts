// What the login of the channels needs from the environment, read by the module that provides it so that the
// service stays free of it (a unit spec has no DATABASE_URL to parse). The address a provider sends the browser
// back to is not here: each plugin declares it (null where its login is off) and the registry holds it to the
// callback of this platform.
export abstract class ChannelOAuthConfig {
  // The public address of the web app, where the callback sends the browser back to
  abstract readonly frontendUrl: string
}
