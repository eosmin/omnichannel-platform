import { Test } from '@nestjs/testing'

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
      graphOrigin: undefined
    })
    expect(moduleRef.get(MetaGraphClient)).toBeInstanceOf(MetaGraphClient)
    jest.dontMock('@platform/core/config/env')
  })

  // The app secret is the key that forges every webhook: the plugins get the client, not the secret
  it('exports the client and not the config that holds the secret', () => {
    expect(Reflect.getMetadata('exports', MetaPlatformModule)).toEqual([MetaGraphClient])
  })
})
