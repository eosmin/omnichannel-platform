import { Injectable, type OnApplicationBootstrap } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { isUniqueViolation, PrismaService } from '@platform/core/database'
import {
  CarrierCapability,
  CodePluginAuthor,
  OfficialPluginAuthor,
  PluginCatalogTypes,
  PluginPricingModels,
  PluginStatus,
  ShippingPlugin,
  isOfficialChannelId
} from '@platform/core/domain'
import { CarrierRegistry, PluginRegistry } from '@platform/plugins/runtime'
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
    private readonly carriers: CarrierRegistry,
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
      // A row that is not the platform's own belongs to whoever published it: this one is written when it is not
      // there, and refreshed only while it carries the marker of a row the code wrote (an address nobody else can
      // have, not a name the publisher chooses), in one statement so that nothing is read and then overwritten
      if (!isOfficialChannelId(plugin.id)) {
        await this.prisma.client.plugin.createMany({
          data: [{ id: plugin.id, ...data, status }],
          skipDuplicates: true
        })
        await this.prisma.client.plugin.updateMany({
          where: {
            id: plugin.id,
            isOfficial: false,
            organizationId: null,
            authorEmail: CodePluginAuthor.EMAIL
          },
          data
        })
        // The id of a plugin of the code that an organization registered first stays the organization's
        const taken = await this.prisma.client.plugin.findFirst({
          where: { id: plugin.id, organizationId: { not: null } },
          select: { id: true }
        })
        if (taken !== null) {
          this.logger.error(
            { pluginId: plugin.id },
            'the id of a plugin of the platform is taken by a plugin an organization registered'
          )
        }
        continue
      }
      // Written when it is not there, and refreshed only while it is not an organization's: the id of an official plugin
      // that an organization registered before the platform shipped it stays the organization's, and the row is never
      // turned into the platform's with the organization's installations and keys under it. Two statements that
      // each decide on the row in the database, so nothing is read and then overwritten.
      await this.prisma.client.plugin.createMany({
        data: [{ id: plugin.id, ...data, status }],
        skipDuplicates: true
      })
      const refreshed = await this.prisma.client.plugin.updateMany({
        where: { id: plugin.id, organizationId: null },
        data
      })
      if (refreshed.count === 0) {
        this.logger.error(
          { pluginId: plugin.id },
          'the id of an official plugin is taken by a plugin an organization registered'
        )
      }
    }
    await this.syncShipping()
    this.logger.info({ count: plugins.length }, 'plugins of the platform written to the catalog')
  }

  // The carriers are one entry of the catalog, `shipping` (D19): a store installs it once and connects the carriers it needs.
  // Written when the platform registers at least one carrier, and refreshed with the list of them. Its status is written once,
  // on creation, like the others.
  private async syncShipping(): Promise<void> {
    const carriers = this.carriers.list()
    if (carriers.length === 0) return
    // The id belongs to the platform: a row of that id that is not official was written by someone else and is left alone
    const existing = await this.prisma.client.plugin.findUnique({
      where: { id: ShippingPlugin.ID },
      select: { isOfficial: true }
    })
    if (existing !== null && !existing.isOfficial) {
      this.logger.error(
        { pluginId: ShippingPlugin.ID },
        'the id of the shipping plugin is taken by another plugin'
      )
      return
    }
    const data = {
      name: ShippingPlugin.NAME,
      authorName: OfficialPluginAuthor.NAME,
      authorEmail: OfficialPluginAuthor.EMAIL,
      type: PluginCatalogTypes.CARRIER,
      isOfficial: true,
      manifest: {
        id: ShippingPlugin.ID,
        name: ShippingPlugin.NAME,
        type: PluginCatalogTypes.CARRIER,
        carriers: carriers.map(carrier => ({
          id: carrier.id,
          version: carrier.version,
          capabilities: Object.values(CarrierCapability).filter(capability =>
            this.carriers.hasCapability(carrier.id, capability)
          )
        }))
      },
      pricingModel: PluginPricingModels.FREE
    }
    const write = () =>
      this.prisma.client.plugin.upsert({
        where: { id: ShippingPlugin.ID },
        create: { id: ShippingPlugin.ID, ...data, status: PluginStatus.APPROVED },
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
}
