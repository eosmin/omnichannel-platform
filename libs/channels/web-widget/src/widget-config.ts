// What the widget needs, read from the environment by the module that provides it. The library never
// reads process.env.
export abstract class WidgetConfig {
  // The key the visitor tokens are signed with (`widgetTokenKey`)
  abstract readonly tokenKey: Buffer
}
