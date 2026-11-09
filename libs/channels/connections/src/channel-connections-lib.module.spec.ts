import { type ChannelOAuthConfig } from './channel-oauth-config'

const callback = '/api/v1/channels/oauth/callback'

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
  it('has the login off when the provider block says no redirect address', async () => {
    const config = await configWith({ NODE_ENV: 'development' })
    expect(config.redirectUri).toBeUndefined()
    expect(config.frontendUrl).toBe('http://localhost:3000')
  })

  it('takes the redirect address from the provider block, validated by its schema', async () => {
    const config = await configWith({
      NODE_ENV: 'development',
      META_APP_ID: '950161111253304',
      META_APP_SECRET: 's'.repeat(32),
      META_OAUTH_REDIRECT_URI: `http://localhost:8080${callback}`
    })
    expect(config.redirectUri).toBe(`http://localhost:8080${callback}`)
  })
})
