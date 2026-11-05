import { createHmac } from 'node:crypto'

import { Test } from '@nestjs/testing'

import { MetaWebhookApps } from '@platform/core/domain'

import { MetaAppConfig } from './meta-app-config'
import { MetaGraphClient } from './meta-graph.client'
import { MetaPlatformModule } from './meta-platform.module'

describe('MetaPlatformModule', () => {
  it('provides the client, configured from the env of the app', async () => {
    jest.doMock('@platform/core/config/env', () => ({
      env: {
        META_APP_SECRET: 'sec',
        META_WEBHOOK_VERIFY_TOKEN: 'ver',
        META_GRAPH_API_VERSION: 'v24.0'
      }
    }))
    const moduleRef = await Test.createTestingModule({ imports: [MetaPlatformModule] }).compile()

    expect(moduleRef.get(MetaAppConfig)).toEqual({
      appSecret: 'sec',
      verifyToken: 'ver',
      graphVersion: 'v24.0',
      graphOrigin: undefined,
      instagramAppSecret: undefined
    })
    // `toEqual` ignores a missing key: the slot must exist, empty
    expect(Object.keys(moduleRef.get(MetaAppConfig))).toContain('instagramAppSecret')
    expect(moduleRef.get(MetaGraphClient)).toBeInstanceOf(MetaGraphClient)
    jest.dontMock('@platform/core/config/env')
  })

  it('reads the secret of the separate Instagram app when the env has one', async () => {
    // The first test left its env in the registry: the factory must read this one
    jest.resetModules()
    jest.doMock('@platform/core/config/env', () => ({
      env: {
        META_APP_SECRET: 'sec',
        META_INSTAGRAM_APP_SECRET: 'ig-sec',
        META_WEBHOOK_VERIFY_TOKEN: 'ver',
        META_GRAPH_API_VERSION: 'v24.0'
      }
    }))
    const moduleRef = await Test.createTestingModule({ imports: [MetaPlatformModule] }).compile()

    expect(moduleRef.get(MetaAppConfig)).toMatchObject({
      appSecret: 'sec',
      instagramAppSecret: 'ig-sec'
    })
    // And through the client the module builds, each secret signs its own app and not the other
    const client = moduleRef.get(MetaGraphClient)
    const body = '{"object":"instagram"}'
    const signed = (secret: string): Record<string, string> => ({
      'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
    })
    expect(client.isValidSignature(body, signed('ig-sec'), MetaWebhookApps.INSTAGRAM)).toBe(true)
    expect(client.isValidSignature(body, signed('sec'), MetaWebhookApps.INSTAGRAM)).toBe(false)
    expect(client.isValidSignature(body, signed('sec'), MetaWebhookApps.MAIN)).toBe(true)
    expect(client.isValidSignature(body, signed('ig-sec'), MetaWebhookApps.MAIN)).toBe(false)
    jest.dontMock('@platform/core/config/env')
  })

  // The app secret is the key that forges every webhook: the plugins get the client, not the secret
  it('exports the client and not the config that holds the secret', () => {
    expect(Reflect.getMetadata('exports', MetaPlatformModule)).toEqual([MetaGraphClient])
  })
})
