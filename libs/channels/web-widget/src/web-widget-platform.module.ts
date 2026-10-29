import { Module } from '@nestjs/common'

import { WidgetConfig, WidgetEmbedConfig } from './widget-config'
import { widgetTokenKey } from './widget-token'

// Derives the key of the visitor tokens from the secret of the api, which a deployed environment
// cannot boot without (env-schema), so the widget never runs unsigned.
//
// The env is imported when the provider is built and not at the top of the file, for the reason given
// in MetaPlatformModule: a unit spec that loads the barrel has no DATABASE_URL to parse.
@Module({
  providers: [
    {
      provide: WidgetConfig,
      useFactory: async (): Promise<WidgetConfig> => {
        const { env } = await import('@platform/core/config/env')
        return { tokenKey: widgetTokenKey(env.JWT_SECRET) }
      }
    },
    {
      provide: WidgetEmbedConfig,
      useFactory: async (): Promise<WidgetEmbedConfig> => {
        const { env } = await import('@platform/core/config/env')
        return { scriptUrl: env.WIDGET_SCRIPT_URL, apiUrl: env.API_URL }
      }
    }
  ],
  exports: [WidgetConfig, WidgetEmbedConfig]
})
export class WebWidgetPlatformModule {}
