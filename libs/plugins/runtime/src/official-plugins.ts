import type { Type } from '@nestjs/common'

import type { CarrierPlugin, ChannelPlugin } from '@platform/plugins/sdk'

// The plugins that ship with the platform. Each channel or carrier library adds its class here
// when it is built (Steps 2.7, 2.8, 4.8 and 4.15).
export const OFFICIAL_CHANNEL_PLUGINS: readonly Type<ChannelPlugin>[] = []
export const OFFICIAL_CARRIER_PLUGINS: readonly Type<CarrierPlugin>[] = []
