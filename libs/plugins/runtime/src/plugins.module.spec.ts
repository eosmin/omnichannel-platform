import { Injectable, type Type } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { PinoLogger } from 'nestjs-pino'

import { MetaAppConfig } from '@platform/channels/meta'
import { WidgetConfig, widgetTokenKey } from '@platform/channels/web-widget'
import { ChannelIds } from '@platform/core/domain'
import { ChannelCapability, type ChannelPlugin } from '@platform/plugins/sdk'

import { CarrierRegistry } from './carrier-registry'
import { OFFICIAL_CHANNEL_PLUGINS } from './official-plugins'
import { PluginRegistry } from './plugin-registry'
import { PluginsModule } from './plugins.module'

const unused = (): never => {
  throw new Error('not used')
}

@Injectable()
class SuitePlugin implements ChannelPlugin {
  readonly id: string = 'suite_channel'
  readonly name = 'Suite'
  readonly version = '1.0.0'
  readonly author = 'suite'
  readonly type = 'channel' as const
  readonly capabilities = [ChannelCapability.TEXT] as const
  readonly messagingWindow = null
  connect = unused
  disconnect = unused
  healthCheck = unused
  sendMessage = unused
  sendMedia = unused
  validateWebhookSignature = (): boolean => false
  handleWebhook = (): Promise<never[]> => Promise.resolve([])
}

describe('PluginsModule', () => {
  it('registers the plugins it is given, at boot, in the registries it exports', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PluginsModule.forRoot({ channels: [SuitePlugin], carriers: [] })]
    })
      .useMocker(token =>
        token === PinoLogger ? { setContext: jest.fn(), info: jest.fn() } : undefined
      )
      .compile()
    await moduleRef.init()

    expect(moduleRef.get(PluginRegistry).has('suite_channel')).toBe(true)
    expect(moduleRef.get(CarrierRegistry).list()).toEqual([])
    await moduleRef.close()
  })

  it('has its plugins registered before any onModuleInit runs', async () => {
    let seen: boolean | undefined
    @Injectable()
    class Early {
      constructor(private readonly registry: PluginRegistry) {}
      onModuleInit(): void {
        seen = this.registry.has('suite_channel')
      }
    }
    const moduleRef = await Test.createTestingModule({
      providers: [Early],
      imports: [PluginsModule.forRoot({ channels: [SuitePlugin], carriers: [] })]
    })
      .useMocker(token =>
        token === PinoLogger ? { setContext: jest.fn(), info: jest.fn() } : undefined
      )
      .compile()
    await moduleRef.init()
    expect(seen).toBe(true)
    await moduleRef.close()
  })

  it('does not let a plugin that is not official take an official id', async () => {
    @Injectable()
    class Impostor extends SuitePlugin {
      override readonly id = 'whatsapp'
    }
    const build = Test.createTestingModule({
      imports: [PluginsModule.forRoot({ channels: [Impostor], carriers: [] })]
    })
      .useMocker(token =>
        token === PinoLogger ? { setContext: jest.fn(), info: jest.fn() } : undefined
      )
      .compile()
    await expect(build).rejects.toThrow(/reserved/)
  })

  it('does not hand the official flag to a subclass of an official class', async () => {
    @Injectable()
    class Official extends SuitePlugin {}
    @Injectable()
    class Subclass extends Official {
      override readonly id = 'whatsapp'
    }
    // The list is empty until the official plugins exist: this one stands in for one of them
    const official = OFFICIAL_CHANNEL_PLUGINS as Type<ChannelPlugin>[]
    official.push(Official)
    try {
      const build = Test.createTestingModule({
        imports: [PluginsModule.forRoot({ channels: [Subclass], carriers: [] })]
      })
        .useMocker(token =>
          token === PinoLogger ? { setContext: jest.fn(), info: jest.fn() } : undefined
        )
        .compile()
      await expect(build).rejects.toThrow(/reserved/)
    } finally {
      official.pop()
    }
  })

  it('does not read the official flag from a property the plugin can set', async () => {
    @Injectable()
    class Official extends SuitePlugin {}
    const official = OFFICIAL_CHANNEL_PLUGINS as Type<ChannelPlugin>[]
    official.push(Official)
    try {
      @Injectable()
      class Wrapper extends SuitePlugin {
        override readonly id = 'whatsapp'
        constructor() {
          super()
          Object.defineProperty(this, 'constructor', { value: Official })
        }
      }
      const build = Test.createTestingModule({
        imports: [PluginsModule.forRoot({ channels: [Wrapper], carriers: [] })]
      })
        .useMocker(token =>
          token === PinoLogger ? { setContext: jest.fn(), info: jest.fn() } : undefined
        )
        .compile()
      await expect(build).rejects.toThrow(/reserved/)
    } finally {
      official.pop()
    }
  })

  it('registers the official plugins by default, as official', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PluginsModule.forRoot()]
    })
      // The config reads the env of the app, which a unit spec does not have
      .overrideProvider(MetaAppConfig)
      .useValue({ appSecret: 's', verifyToken: 'v', graphVersion: 'v23.0' })
      .overrideProvider(WidgetConfig)
      .useValue({ tokenKey: widgetTokenKey('s'.repeat(32)) })
      .useMocker(token =>
        token === PinoLogger ? { setContext: jest.fn(), info: jest.fn() } : undefined
      )
      .compile()
    await moduleRef.init()

    const ids = moduleRef
      .get(PluginRegistry)
      .list('any-store')
      .map(plugin => plugin.id)
    expect(ids).toEqual([
      ChannelIds.WHATSAPP,
      ChannelIds.INSTAGRAM,
      ChannelIds.MESSENGER,
      ChannelIds.WEB_WIDGET
    ])
    await moduleRef.close()
  })

  // The whole path the apps use: the env of the app, the module that reads it, the plugin that gets the
  // client. Only the env itself is replaced.
  it('gives the official plugin the app secret of the env, through the real Meta module', async () => {
    jest.resetModules()
    jest.doMock('@platform/core/config/env', () => ({
      env: {
        META_APP_SECRET: 'wiring-secret',
        META_WEBHOOK_VERIFY_TOKEN: 'wiring-verify',
        META_GRAPH_API_VERSION: 'v23.0',
        JWT_SECRET: 'j'.repeat(32)
      }
    }))
    const { PluginsModule: Fresh } = await import('./plugins.module')
    const { PluginRegistry: FreshRegistry } = await import('./plugin-registry')
    // After resetModules the logger class is a new one, and the token must be the same class
    const { PinoLogger: FreshLogger } = await import('nestjs-pino')
    const moduleRef = await Test.createTestingModule({ imports: [Fresh.forRoot()] })
      .useMocker(token =>
        token === FreshLogger ? { setContext: jest.fn(), info: jest.fn() } : undefined
      )
      .compile()
    await moduleRef.init()

    const plugin = moduleRef.get(FreshRegistry).get(ChannelIds.WHATSAPP)
    expect(
      plugin.verifyWebhook?.({
        'hub.mode': 'subscribe',
        'hub.verify_token': 'wiring-verify',
        'hub.challenge': '7'
      })
    ).toBe('7')
    expect(
      plugin.verifyWebhook?.({
        'hub.mode': 'subscribe',
        'hub.verify_token': 'other',
        'hub.challenge': '7'
      })
    ).toBeNull()
    await moduleRef.close()
    jest.dontMock('@platform/core/config/env')
  })
})
