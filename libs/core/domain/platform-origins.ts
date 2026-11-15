// The origins the platform itself is served from: the web app, the api and the script of the web widget. A plugin
// widget must never be on one of them (TDD_10 §7): its frame keeps `allow-same-origin`, which is safe only because the
// frame's origin is not ours. Read from the validated env here, so that a service receives it and never reads the
// environment itself.
export abstract class PlatformOrigins {
  abstract readonly origins: readonly string[]
}
