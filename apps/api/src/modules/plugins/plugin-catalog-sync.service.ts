import { Injectable, type OnApplicationBootstrap } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { isUniqueViolation, PrismaService } from '@platform/core/database'
import {
  OfficialPluginAuthor,
  PluginCatalogTypes,
  PluginPricingModels,
  PluginStatus
} from '@platform/core/domain'
import { PluginRegistry } from '@platform/plugins/runtime'
import type { ChannelPlugin } from '@platform/plugins/sdk'

// What the catalog shows of a plugin that ships with the platform, and the manifest it keeps for it
function officialRow(plugin: ChannelPlugin) {
  return {
    name: plugin.name,
    authorName: OfficialPluginAuthor.NAME,
    authorEmail: OfficialPluginAuthor.EMAIL,
    type: PluginCatalogTypes.CHANNEL,
    isOfficial: true,
    manifest: {
      id: plugin.id,
      name: plugin.name,
      version: plugin.version,
      type: plugin.type,
      capabilities: [...plugin.capabilities]
    },
    pricingModel: PluginPricingModels.FREE,
    status: PluginStatus.APPROVED
  }
}

// Writes a catalog row for each official plugin of the code registry at boot (D19), so a store can
// install it like any other. Idempotent: a boot with nothing new changes nothing, and a plugin that
// is renamed or gains a capability is updated.
@Injectable()
export class PluginCatalogSync implements OnApplicationBootstrap {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: PluginRegistry,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(PluginCatalogSync.name)
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.sync()
  }

  async sync(): Promise<void> {
    const plugins = this.registry.listOfficial()
    for (const plugin of plugins) {
      // The status is written once, on creation: a plugin the owner suspended stays suspended
      const { status, ...data } = officialRow(plugin)
      const write = () =>
        this.prisma.client.plugin.upsert({
          where: { id: plugin.id },
          create: { id: plugin.id, ...data, status },
          update: data
        })
      try {
        await write()
      } catch (error) {
        // Another instance booting at the same time wrote it first: the second write updates
        if (!isUniqueViolation(error)) throw error
        await write()
      }
    }
    this.logger.info({ count: plugins.length }, 'official plugins written to the catalog')
  }
}
