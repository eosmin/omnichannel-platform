import {
  pluginBridgeRequestSchema,
  PluginBridgeMessages,
  PluginBridgeOperations,
  pluginWidgetManifestSchema
} from './plugin-widgets'

const widget = { id: 'info', name: 'Info', defaultWidth: 300, defaultHeight: 400 }
const manifest = (url: string, widgets: unknown[] = [widget]) => ({
  ui: { widget: url },
  widgets
})

describe('pluginWidgetManifestSchema', () => {
  it('accepts an https widget url with its declarations', () => {
    expect(
      pluginWidgetManifestSchema.safeParse(manifest('https://acme.example/plugin/widget')).success
    ).toBe(true)
  })

  it.each([
    ['plain http', 'http://acme.example/widget'],
    ['a javascript url', 'javascript:alert(1)'],
    ['credentials in the url', 'https://user:pass@acme.example/widget'],
    ['a fragment', 'https://acme.example/widget#token'],
    ['a query (the page adds its own)', 'https://acme.example/widget?x=1']
  ])('refuses %s', (_label, url) => {
    expect(pluginWidgetManifestSchema.safeParse(manifest(url)).success).toBe(false)
  })

  it('refuses repeated widget ids, an empty list and out-of-range sizes', () => {
    const url = 'https://acme.example/widget'
    expect(pluginWidgetManifestSchema.safeParse(manifest(url, [widget, widget])).success).toBe(
      false
    )
    expect(pluginWidgetManifestSchema.safeParse(manifest(url, [])).success).toBe(false)
    expect(
      pluginWidgetManifestSchema.safeParse(manifest(url, [{ ...widget, defaultHeight: 5000 }]))
        .success
    ).toBe(false)
  })
})

describe('pluginBridgeRequestSchema', () => {
  const valid = {
    type: PluginBridgeMessages.REQUEST,
    id: 'req-1',
    operation: PluginBridgeOperations.CUSTOMER_GET
  }

  it('accepts a request with a known operation', () => {
    expect(pluginBridgeRequestSchema.safeParse(valid).success).toBe(true)
  })

  it('refuses an unknown operation, another message type and extra keys (a conversation id the frame chose)', () => {
    expect(
      pluginBridgeRequestSchema.safeParse({ ...valid, operation: 'orders.list' }).success
    ).toBe(false)
    expect(pluginBridgeRequestSchema.safeParse({ ...valid, type: 'other' }).success).toBe(false)
    expect(
      pluginBridgeRequestSchema.safeParse({ ...valid, conversationId: 'another' }).success
    ).toBe(false)
  })
})
