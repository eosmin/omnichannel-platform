import { Injectable, type OnApplicationBootstrap } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { isUniqueViolation, PrismaService } from '@platform/core/database'
import {
  CodePluginAuthor,
  OfficialPluginAuthor,
  PluginCatalogTypes,
  PluginPricingModels,
  PluginStatus,
  isOfficialChannelId
} from '@platform/core/domain'
import { PluginRegistry } from '@platform/plugins/runtime'
import type { ChannelPlugin } from '@platform/plugins/sdk'

// What the catalog shows of a plugin that ships with the platform, and the manifest it keeps for it
function officialRow(plugin: ChannelPlugin) {
  const official = isOfficialChannelId(plugin.id)
  return {
    name: plugin.name,
    // A plugin the code registers that is not official (the toy channel of the suites) is its own author
    authorName: official
      ? OfficialPluginAuthor.NAME
      : String(plugin.author).slice(0, CodePluginAuthor.NAME_MAX_LENGTH),
    authorEmail: official ? OfficialPluginAuthor.EMAIL : CodePluginAuthor.EMAIL,
    type: PluginCatalogTypes.CHANNEL,
    isOfficial: official,
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

// Writes a catalog row for each plugin the code of the platform registers at boot (D19: the official ones, and the
// toy channel of the suites when the environment turns it on), so a store can
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
    const plugins = this.registry.listFromCode()
    for (const plugin of plugins) {
      // The status is written once, on creation: a plugin the owner suspended stays suspended
      const { status, ...data } = officialRow(plugin)
      // A row that is not the platform's own belongs to whoever published it: this one is written when it is
      // not there, refreshed only while its author is the plugin's own, and never taken over from another
      if (!isOfficialChannelId(plugin.id)) {
        const existing = await this.prisma.client.plugin.findUnique({
          where: { id: plugin.id },
          select: { authorName: true, isOfficial: true }
        })
        if (existing !== null && (existing.isOfficial || existing.authorName !== data.authorName)) {
          this.logger.warn(
            { pluginId: plugin.id },
            'a catalog row of another publisher is left as it is'
          )
          continue
        }
      }
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
    this.logger.info({ count: plugins.length }, 'plugins of the platform written to the catalog')
  }
}
