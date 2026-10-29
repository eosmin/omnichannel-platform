// What the widget needs, read from the environment by the module that provides it. The library never
// reads process.env.
export abstract class WidgetConfig {
  // The key the visitor tokens are signed with (`widgetTokenKey`)
  abstract readonly tokenKey: Buffer
}

// What the snippet of a store needs: where the script is served from and where the api answers
export abstract class WidgetEmbedConfig {
  abstract readonly scriptUrl: string
  abstract readonly apiUrl: string
}
