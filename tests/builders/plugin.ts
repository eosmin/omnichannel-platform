import { randomBytes } from 'node:crypto'

import { hashToken } from '@platform/core/crypto'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  PLUGIN_API_KEY_TOKEN_PREFIX,
  PluginCatalogTypes,
  PluginInstallationStatus,
  PluginInstallLimits,
  PluginPricingModels,
  PluginStatus
} from '@platform/core/domain'
import type { PluginScope } from '@platform/plugins/sdk'

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

// A third-party integration plugin that declares one widget (TDD_10 §7), installed and active in a store with the
// scopes given. The row is written by the owner client because registering and installing an integration plugin
// is Step 5.6; the suites that need one build it here. A second call changes the scopes and the url.
export async function ensureWidgetPlugin(
  owner: OwnerClient,
  input: {
    storeId: string
    pluginId: string
    widgetUrl: string
    scopes: string[]
    widgetName?: string | undefined
  }
): Promise<{ id: string }> {
  const manifest = {
    ui: { widget: input.widgetUrl },
    widgets: [{ id: 'info', name: input.widgetName ?? 'Info panel', defaultHeight: 300 }]
  }
  // An integration plugin belongs to the organization that registered it (D10; a check enforces it)
  const store = await owner.store.findUniqueOrThrow({
    where: { id: input.storeId },
    select: { organizationId: true }
  })
  await owner.plugin.upsert({
    where: { id: input.pluginId },
    create: {
      id: input.pluginId,
      organizationId: store.organizationId,
      name: input.pluginId,
      authorName: 'suite',
      authorEmail: 'suite@example.invalid',
      type: PluginCatalogTypes.INTEGRATION,
      manifest,
      pricingModel: PluginPricingModels.FREE,
      status: PluginStatus.APPROVED
    },
    update: { manifest, status: PluginStatus.APPROVED }
  })
  return owner.pluginInstallation.upsert({
    where: { storeId_pluginId: { storeId: input.storeId, pluginId: input.pluginId } },
    create: {
      storeId: input.storeId,
      pluginId: input.pluginId,
      scopes: input.scopes,
      status: PluginInstallationStatus.ACTIVE,
      installedBy: 'suite'
    },
    update: { scopes: input.scopes, status: PluginInstallationStatus.ACTIVE, revokedAt: null },
    select: { id: true }
  })
}

// An approved integration plugin, installed and active in a store with the scopes given, and its key: what the setup exchange
// leaves, written by the owner client so that a suite of the plugin API does not have to run the install flow for each store and
// scope set (a second call for the same store and plugin makes a new key and the first stops working). Only the hash is stored, as the exchange does; the key is returned once, for the suite to send.
export async function createPluginKey(
  owner: OwnerClient,
  input: { storeId: string; pluginId: string; scopes: readonly PluginScope[] }
): Promise<{ key: string; installationId: string }> {
  const store = await owner.store.findUniqueOrThrow({
    where: { id: input.storeId },
    select: { organizationId: true }
  })
  await owner.plugin.upsert({
    where: { id: input.pluginId },
    create: {
      id: input.pluginId,
      organizationId: store.organizationId,
      name: input.pluginId,
      authorName: 'suite',
      authorEmail: 'suite@example.invalid',
      type: PluginCatalogTypes.INTEGRATION,
      manifest: {},
      pricingModel: PluginPricingModels.FREE,
      status: PluginStatus.APPROVED
    },
    update: { status: PluginStatus.APPROVED }
  })
  const key = `${PLUGIN_API_KEY_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
  const installation = await owner.pluginInstallation.upsert({
    where: { storeId_pluginId: { storeId: input.storeId, pluginId: input.pluginId } },
    create: {
      storeId: input.storeId,
      pluginId: input.pluginId,
      scopes: [...input.scopes],
      status: PluginInstallationStatus.ACTIVE,
      installedBy: 'suite',
      apiKeyHash: hashToken(key),
      apiKeyPrefix: key.slice(0, PluginInstallLimits.KEY_DISPLAY_PREFIX_LENGTH)
    },
    update: {
      scopes: [...input.scopes],
      status: PluginInstallationStatus.ACTIVE,
      revokedAt: null,
      apiKeyHash: hashToken(key),
      apiKeyPrefix: key.slice(0, PluginInstallLimits.KEY_DISPLAY_PREFIX_LENGTH)
    },
    select: { id: true }
  })
  return { key, installationId: installation.id }
}
