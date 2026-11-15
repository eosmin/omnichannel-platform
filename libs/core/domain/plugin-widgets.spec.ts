import {
  pluginBridgeReadySchema,
  pluginBridgeRequestSchema,
  pluginWidgetConfigSchema,
  pluginWidgetVisibilitySchema,
  PluginWidgetFrames,
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

describe('pluginBridgeReadySchema', () => {
  it('is exactly the ready message and nothing more', () => {
    expect(pluginBridgeReadySchema.safeParse({ type: PluginBridgeMessages.READY }).success).toBe(
      true
    )
    expect(
      pluginBridgeReadySchema.safeParse({ type: PluginBridgeMessages.READY, token: 'x' }).success
    ).toBe(false)
    expect(pluginBridgeReadySchema.safeParse({ type: PluginBridgeMessages.REQUEST }).success).toBe(
      false
    )
  })
})

describe('pluginWidgetConfigSchema', () => {
  it('hides nothing by default and keeps the keys of the config that are not its own', () => {
    expect(pluginWidgetConfigSchema.parse({})).toEqual({ hiddenWidgets: [] })
    expect(pluginWidgetConfigSchema.parse({ hiddenWidgets: ['info'], other: 1 })).toEqual({
      hiddenWidgets: ['info'],
      other: 1
    })
  })

  it.each([
    ['a string', 'info'],
    ['a list of numbers', [1]],
    ['null', null]
  ])('refuses a hidden list that is %s', (_label, hiddenWidgets) => {
    expect(pluginWidgetConfigSchema.safeParse({ hiddenWidgets }).success).toBe(false)
  })
})

describe('pluginWidgetVisibilitySchema', () => {
  it('is one boolean', () => {
    expect(pluginWidgetVisibilitySchema.safeParse({ visible: false }).success).toBe(true)
    expect(pluginWidgetVisibilitySchema.safeParse({ visible: 'no' }).success).toBe(false)
    expect(pluginWidgetVisibilitySchema.safeParse({ visible: true, extra: 1 }).success).toBe(false)
  })
})

describe('PluginWidgetFrames', () => {
  it('separates origins with a character that cannot be part of one', () => {
    expect(PluginWidgetFrames.COOKIE_SEPARATOR).toBe(' ')
    expect(new URL('https://widgets.acme.example').origin).not.toContain(
      PluginWidgetFrames.COOKIE_SEPARATOR
    )
  })
})
