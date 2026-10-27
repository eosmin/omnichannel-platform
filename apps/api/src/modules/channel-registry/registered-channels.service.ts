import { Injectable } from '@nestjs/common'

import { type ChannelId, isOfficialChannelId } from '@platform/core/domain'
import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'
import { PluginRegistry } from '@platform/plugins/runtime'

// What a route that takes a channel from a request asks before it uses the id. A schema checks the
// shape of the id and cannot reach the registry; this is the other half. A channel is the id of a
// plugin the store may use: a private plugin of another store is as unknown as one nobody wrote.
// An official id is always valid, because the official plugins are part of the code; until their
// libraries exist (Steps 2.7 and 2.8) the registry holds none of them, and the api must keep
// accepting the ids it accepted before the channel became an open id.
@Injectable()
export class RegisteredChannels {
  constructor(private readonly registry: PluginRegistry) {}

  require(storeId: string, channels: readonly ChannelId[]): void {
    const unknown = channels.filter(
      id => !isOfficialChannelId(id) && !this.registry.isVisibleTo(id, storeId)
    )
    if (unknown.length > 0) {
      throw new PlatformException(
        ErrorCodes.VALIDATION_FAILED,
        'unknown channel',
        HttpStatusCodes.BAD_REQUEST,
        // Each id already matched the shape of an id, so it is short and plain
        { channels: unknown }
      )
    }
  }
}
