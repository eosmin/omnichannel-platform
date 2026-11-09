import { Test } from '@nestjs/testing'
import { PinoLogger } from 'nestjs-pino'

import { MetaAppConfig } from '@platform/channels/meta'
import { WidgetConfig, WidgetEmbedConfig, widgetTokenKey } from '@platform/channels/web-widget'

import { PluginRegistry } from './plugin-registry'
import { PluginsModule } from './plugins.module'

// The toy channel asks the environment of the core whether it is on: here the environment is whatever the case sets
let mockEnv: Record<string, string> = { NODE_ENV: 'test' }
jest.mock('@platform/core/config/env', () => ({
  envSource: (): Record<string, string> => mockEnv
}))

describe('PluginsModule and the toy channel of the suites', () => {
  async function registryWith(env: Record<string, string>): Promise<PluginRegistry> {
    mockEnv = env
    const moduleRef = await Test.createTestingModule({ imports: [PluginsModule.forRoot()] })
      // The configs read the env of the app, which a unit spec does not have
      .overrideProvider(MetaAppConfig)
      .useValue({ appSecret: 's', verifyToken: 'v', graphVersion: 'v23.0' })
      .overrideProvider(WidgetConfig)
      .useValue({ tokenKey: widgetTokenKey('s'.repeat(32)) })
      .overrideProvider(WidgetEmbedConfig)
      .useValue({
        scriptUrl: 'https://cdn.example.com/widget.js',
        apiUrl: 'https://api.example.com'
      })
      .useMocker(token => {
        if (token === PinoLogger) return { setContext: jest.fn(), info: jest.fn() }
        return typeof token === 'function' && token.name === 'StorageService' ? {} : undefined
      })
      .compile()
    await moduleRef.init()
    return moduleRef.get(PluginRegistry)
  }
  afterEach(() => {
    mockEnv = { NODE_ENV: 'test' }
  })

  it('registers it as a plugin of a third party only when a test environment turns it on', async () => {
    expect((await registryWith({ NODE_ENV: 'test' })).has('acme_chat')).toBe(false)
    const on = await registryWith({ NODE_ENV: 'test', E2E_TOY_PLUGIN: '1' })
    expect(on.has('acme_chat')).toBe(true)
    expect(on.listOfficial().map(plugin => plugin.id)).not.toContain('acme_chat')
    expect(on.listFromCode().map(plugin => plugin.id)).toContain('acme_chat')
  })

  it('does not boot in an environment that is not a test one with the switch on', async () => {
    await expect(registryWith({ NODE_ENV: 'development', E2E_TOY_PLUGIN: '1' })).rejects.toThrow(
      /NODE_ENV=test only/
    )
  })
})
