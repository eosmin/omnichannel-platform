import { type ChannelOAuthConfig } from './channel-oauth-config'

// Only the provider of the login is under test: the module also builds the crypto of the app, which needs the real env
async function configWith(source: Record<string, string>): Promise<ChannelOAuthConfig> {
  jest.resetModules()
  jest.doMock('@platform/core/config/env', () => ({
    env: { FRONTEND_URL: 'http://localhost:3000' },
    envSource: () => source
  }))
  // The crypto module of the app is another module's business here
  jest.doMock('@platform/core/http', () => ({
    CryptoPlatformModule: class CryptoPlatformModule {}
  }))
  try {
    const { ChannelConnectionsLibModule } = await import('./channel-connections-lib.module')
    const { ChannelOAuthConfig: Token } = await import('./channel-oauth-config')
    const providers = Reflect.getMetadata('providers', ChannelConnectionsLibModule) as {
      provide?: unknown
      useFactory?: () => Promise<ChannelOAuthConfig>
    }[]
    const entry = providers.find(provider => provider.provide === Token)
    if (entry?.useFactory === undefined) throw new Error('no provider of the login config')
    return await entry.useFactory()
  } finally {
    jest.dontMock('@platform/core/config/env')
    jest.dontMock('@platform/core/http')
  }
}

describe('ChannelConnectionsLibModule, the config of the login', () => {
  it('holds the address of the web app and no redirect address: each plugin declares its own', async () => {
    const config = await configWith({ NODE_ENV: 'development' })
    expect(config.frontendUrl).toBe('http://localhost:3000')
    expect('redirectUri' in config).toBe(false)
  })
})
