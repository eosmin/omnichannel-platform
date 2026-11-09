import { Module } from '@nestjs/common'

import { MetaAppConfig } from './meta-app-config'
import { META_ENV_KEYS, parseMetaEnv } from './meta-env'
import { MetaGraphClient } from './meta-graph.client'

// The platform's Meta app (and, optionally, a second one for Instagram), configured from the validated env. The client stays free of the
// environment; this is the only place that reads it. A deployed environment cannot boot without the
// secret and the verify token (`meta-env.ts`), so the webhook never refuses everything in silence there.
//
// The env is imported when the provider is built and not at the top of the file: this module is
// reached from the plugin barrel, and a unit spec that loads the barrel has no DATABASE_URL to parse.
@Module({
  providers: [
    {
      provide: MetaAppConfig,
      useFactory: async (): Promise<MetaAppConfig> => {
        const { envSource } = await import('@platform/core/config/env')
        // Parsed here, with the plugin's own schema: a deployed environment without the secret and the verify
        // token still cannot boot, the failure just comes from this module and not from the core's env
        const env = parseMetaEnv(envSource(META_ENV_KEYS))
        return {
          appSecret: env.META_APP_SECRET,
          appId: env.META_APP_ID,
          instagramAppSecret: env.META_INSTAGRAM_APP_SECRET,
          verifyToken: env.META_WEBHOOK_VERIFY_TOKEN,
          graphVersion: env.META_GRAPH_API_VERSION,
          graphOrigin: env.META_GRAPH_ORIGIN
        }
      }
    },
    MetaGraphClient
  ],
  exports: [MetaGraphClient]
})
export class MetaPlatformModule {}
