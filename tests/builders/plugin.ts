import type { OwnerClient } from '@platform/core/database-testing'
import {
  PluginCatalogTypes,
  PluginInstallationStatus,
  PluginPricingModels,
  PluginStatus
} from '@platform/core/domain'

// The catalog row of a plugin the suites use, and its active installation in a store: what a
// channel connection hangs from (D19). The row is approved, because a connection works only for an
// approved plugin; the catalog lists it only where the registry holds the plugin, which a running
// api never does for a suite's ids, so development does not see them.
export async function ensurePluginInstallation(
  owner: OwnerClient,
  input: { storeId: string; pluginId: string }
): Promise<{ id: string }> {
  // ON CONFLICT DO NOTHING: suites that run side by side share the id of the test channel
  await owner.plugin.createMany({
    data: [
      {
        id: input.pluginId,
        name: input.pluginId,
        authorName: 'suite',
        authorEmail: 'suite@example.invalid',
        type: PluginCatalogTypes.CHANNEL,
        manifest: {},
        pricingModel: PluginPricingModels.FREE,
        status: PluginStatus.APPROVED
      }
    ],
    skipDuplicates: true
  })
  // A row written by an earlier run, or by a suite that changed it
  await owner.plugin.updateMany({
    where: { id: input.pluginId, authorName: 'suite' },
    data: { status: PluginStatus.APPROVED }
  })
  return owner.pluginInstallation.upsert({
    where: { storeId_pluginId: { storeId: input.storeId, pluginId: input.pluginId } },
    create: {
      storeId: input.storeId,
      pluginId: input.pluginId,
      scopes: [],
      status: PluginInstallationStatus.ACTIVE,
      installedBy: 'suite'
    },
    update: { status: PluginInstallationStatus.ACTIVE, revokedAt: null },
    select: { id: true }
  })
}
