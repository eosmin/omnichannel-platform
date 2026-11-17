import { Injectable } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import {
  isForeignKeyViolation,
  isUniqueViolation,
  lockStoreForWrite,
  PrismaService
} from '@platform/core/database'
import {
  PLUGIN_INSTALLATION_RESOURCE_TYPE,
  PluginCatalogTypes,
  PluginInstallationStatus,
  PluginStatus
} from '@platform/core/domain'
import {
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  resourceNotFound
} from '@platform/core/errors'
import { type PluginManifest, pluginManifestSchema } from '@platform/plugins/runtime'
import type { PluginScope } from '@platform/plugins/sdk'

import type { Actor } from '../tenancy'

import { PluginChallengeService } from './plugin-challenge.service'
import { knownScopes, rateLimitOf, sameScopes, scopeChanges } from './plugin-install-rules'
import { PluginSetupCodeStore } from './plugin-setup-code.store'

// The store of the request, as the catalog sees it (the organization decides which private plugins exist for it)
interface StoreRef {
  id: string
  organizationId: string
}

// What the owner reads before authorizing: exactly what the plugin would be granted, in the words of the manifest. The texts
// are the author's and are drawn as text, never as markup (the manifest validator refused markup).
export interface PluginConsent {
  plugin: {
    id: string
    name: string
    version: string
    description: string
    authorName: string
    authorEmail: string
    authorUrl: string | null
  }
  // Everything the manifest asks for now
  scopes: PluginScope[]
  // What the installation of this store holds today (empty before the first install)
  grantedScopes: PluginScope[]
  // Asked for and not held: what a new consent screen has to show again
  newScopes: PluginScope[]
  rateLimitPerMinute: number
  webhooks: { endpoint: string; events: string[] } | null
  legal: { privacyPolicy: string | null; termsOfService: string | null }
  settingsUrl: string | null
  installation: { id: string; status: string } | null
}

// What the owner is handed when an install is waiting for its plugin: the one-time code (shown once) and where it goes
export interface PluginSetupOffer {
  installationId: string
  code: string
  expiresAt: string
  // The settings page of the plugin, if its manifest names one: the interface sends the owner there with the code
  settingsUrl: string | null
}

interface IntegrationRow {
  manifest: PluginManifest
}

// The install flow of an integration plugin (TDD_10 §6.3): the consent, the challenge of its webhook endpoint, the installation
// in PENDING_SETUP and the one-time code. The key does not exist until the plugin trades its code for it
// (PluginSetupExchangeService), so there is no key to lose between the install and the exchange.
@Injectable()
export class PluginIntegrationInstallService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly challenge: PluginChallengeService,
    private readonly codes: PluginSetupCodeStore,
    private readonly audit: AuditService
  ) {}

  async consent(store: StoreRef, pluginId: string): Promise<PluginConsent> {
    const { manifest } = await this.load(store, pluginId)
    const installation = await this.prisma.client.pluginInstallation.findUnique({
      where: { storeId_pluginId: { storeId: store.id, pluginId } },
      select: { id: true, status: true, scopes: true }
    })
    // A revoked installation holds nothing: its scopes are what a new install would ask for again
    const grantedScopes =
      installation === null || installation.status === String(PluginInstallationStatus.REVOKED)
        ? []
        : knownScopes(installation.scopes)
    return {
      plugin: {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        authorName: manifest.author.name,
        authorEmail: manifest.author.email,
        authorUrl: manifest.author.url ?? null
      },
      scopes: knownScopes(manifest.scopes),
      grantedScopes,
      newScopes: scopeChanges(grantedScopes, manifest.scopes).added,
      rateLimitPerMinute: rateLimitOf(manifest),
      webhooks:
        manifest.webhooks === undefined
          ? null
          : { endpoint: manifest.webhooks.endpoint, events: [...manifest.webhooks.events] },
      legal: {
        privacyPolicy: manifest.legal?.privacyPolicy ?? null,
        termsOfService: manifest.legal?.termsOfService ?? null
      },
      settingsUrl: manifest.ui?.settings ?? null,
      installation:
        installation === null ? null : { id: installation.id, status: installation.status }
    }
  }

  // Installs the plugin with the scopes the owner authorized, which must be exactly the ones the manifest asks for now (a
  // manifest that changed after the consent screen is refused, not granted). A first install, or an install after a
  // revocation, ends with a setup code; an installation that is already active takes the new scopes of a newer manifest
  // (and its new endpoint, after the challenge) and has no code, because it has its key.
  async install(
    store: StoreRef,
    pluginId: string,
    authorized: readonly string[],
    actor: Actor
  ): Promise<PluginSetupOffer | null> {
    const storeId = store.id
    const { manifest } = await this.load(store, pluginId)
    if (
      !sameScopes(authorized, manifest.scopes) ||
      new Set(authorized).size !== authorized.length
    ) {
      throw new PlatformException(
        ErrorCodes.PLUGIN_CONSENT_MISMATCH,
        'the scopes authorized are not the ones the plugin asks for',
        HttpStatusCodes.CONFLICT,
        { required: knownScopes(manifest.scopes) }
      )
    }
    const scopes = knownScopes(manifest.scopes)
    const endpoint = manifest.webhooks?.endpoint ?? null
    const rateLimit = rateLimitOf(manifest)

    const existing = await this.prisma.client.pluginInstallation.findUnique({
      where: { storeId_pluginId: { storeId, pluginId } },
      select: { status: true, scopes: true, webhookEndpoint: true, rateLimitPerMinute: true }
    })
    const isActive = existing?.status === String(PluginInstallationStatus.ACTIVE)
    if (
      isActive &&
      sameScopes(existing.scopes, scopes) &&
      existing.webhookEndpoint === endpoint &&
      existing.rateLimitPerMinute === rateLimit
    ) {
      throw alreadyInstalled()
    }
    // The address is asked before anything is written, and no lock is held while the network answers. An active installation
    // that keeps its endpoint has already passed it.
    if (endpoint !== null && !(isActive && existing.webhookEndpoint === endpoint)) {
      await this.challenge.run(pluginId, endpoint)
    }

    const write = () =>
      this.prisma.transaction(async tx => {
        await lockStoreForWrite(tx, storeId)
        // The plugin row is held while the installation is written, and the archive of the plugin takes it first: the install either
        // sees the plugin archived (it is gone for the organization) or the archive sees this installation and refuses (N-A7-08)
        const [held] = await tx.$queryRaw<
          { status: string }[]
        >`SELECT status FROM plugins WHERE id = ${pluginId} FOR SHARE`
        if (held === undefined || held.status !== String(PluginStatus.APPROVED)) {
          throw resourceNotFound('plugin')
        }
        const current = await tx.pluginInstallation.findUnique({
          where: { storeId_pluginId: { storeId, pluginId } },
          select: {
            id: true,
            status: true,
            scopes: true,
            webhookEndpoint: true,
            rateLimitPerMinute: true
          }
        })
        if (current === null) {
          const created = await tx.pluginInstallation.create({
            data: {
              storeId,
              pluginId,
              scopes,
              webhookEndpoint: endpoint,
              rateLimitPerMinute: rateLimit,
              status: PluginInstallationStatus.PENDING_SETUP,
              installedBy: actor.userId
            },
            select: { id: true }
          })
          return { id: created.id, mode: 'pending' as const, changes: null }
        }
        if (current.status === String(PluginInstallationStatus.ACTIVE)) {
          // Re-read under the lock: another install may have taken these scopes while the challenge ran
          if (
            sameScopes(current.scopes, scopes) &&
            current.webhookEndpoint === endpoint &&
            current.rateLimitPerMinute === rateLimit
          ) {
            throw alreadyInstalled()
          }
          const changes = scopeChanges(current.scopes, scopes)
          await tx.pluginInstallation.update({
            where: { id: current.id },
            data: {
              scopes,
              webhookEndpoint: endpoint,
              rateLimitPerMinute: rateLimit,
              // A new endpoint passed the challenge just now: an installation whose webhooks the failures had turned off starts
              // delivering again. The same endpoint was not asked anything, so it stays as it was.
              ...(current.webhookEndpoint === endpoint
                ? {}
                : {
                    webhookDisabledAt: null,
                    webhookConsecutiveFailures: 0,
                    webhookLastFailureAt: null
                  })
            }
          })
          return { id: current.id, mode: 'updated' as const, changes }
        }
        // Pending (installed again before the plugin set up) or revoked: a new install, with no key until the exchange
        await tx.pluginInstallation.update({
          where: { id: current.id },
          data: {
            scopes,
            webhookEndpoint: endpoint,
            rateLimitPerMinute: rateLimit,
            status: PluginInstallationStatus.PENDING_SETUP,
            apiKeyPrefix: null,
            apiKeyHash: null,
            // What the plugin held is void: it gets new ones when it sets itself up
            commandSecret: null,
            commandSecretPrevious: null,
            commandSecretRotatedAt: null,
            // Nothing of the earlier incarnation is kept: the secret it was given is not this plugin's to sign with, and its
            // failures are not this install's
            webhookSecret: null,
            webhookDisabledAt: null,
            webhookConsecutiveFailures: 0,
            webhookLastFailureAt: null,
            revokedAt: null,
            installedBy: actor.userId
          }
        })
        return { id: current.id, mode: 'pending' as const, changes: null }
      })
    let written: Awaited<ReturnType<typeof write>>
    try {
      written = await write()
    } catch (error) {
      // The plugin was deleted between the check and the write (its installations were none, so the delete went through): it does not
      // exist any more, which is what the next call would be told
      // (a foreign key can fail for another reason, so the plugin is asked about before it is called gone)
      if (
        isForeignKeyViolation(error) &&
        (await this.prisma.client.plugin.count({ where: { id: pluginId } })) === 0
      ) {
        throw resourceNotFound('plugin')
      }
      // Two first installs at once: the second one finds the first one's row and is told so
      if (!isUniqueViolation(error)) throw error
      throw alreadyInstalled()
    }

    if (written.mode === 'updated') {
      this.record(AuditAction.PLUGIN_SCOPES_UPDATED, storeId, written.id, actor, {
        pluginId,
        added: written.changes?.added ?? [],
        removed: written.changes?.removed ?? []
      })
      return null
    }
    // A code from an install that was never finished is void: only the new one works
    this.record(AuditAction.PLUGIN_INSTALLED, storeId, written.id, actor, { pluginId, scopes })
    return this.offer(written.id, storeId, manifest)
  }

  // A new code for an installation that has not been set up: the first one expired, or was lost. The earlier one stops working.
  async reissue(store: StoreRef, installationId: string, actor: Actor): Promise<PluginSetupOffer> {
    const installation = await this.prisma.client.pluginInstallation.findFirst({
      where: {
        id: installationId,
        storeId: store.id,
        plugin: { type: { in: [PluginCatalogTypes.INTEGRATION, PluginCatalogTypes.CHANNEL] } }
      },
      select: { id: true, status: true, pluginId: true }
    })
    if (installation === null) throw resourceNotFound('plugin installation')
    if (installation.status !== String(PluginInstallationStatus.PENDING_SETUP)) {
      throw new PlatformException(
        installation.status === String(PluginInstallationStatus.ACTIVE)
          ? ErrorCodes.PLUGIN_ALREADY_INSTALLED
          : ErrorCodes.PLUGIN_NOT_INSTALLED,
        'only an installation that is waiting for its plugin takes a new code',
        HttpStatusCodes.CONFLICT
      )
    }
    const { manifest } = await this.load(store, installation.pluginId)
    const offer = await this.offer(installation.id, store.id, manifest)
    this.record(AuditAction.PLUGIN_SETUP_CODE_ISSUED, store.id, installation.id, actor, {
      pluginId: installation.pluginId
    })
    return offer
  }

  // The installation was revoked: a code that was still waiting stops working
  voidSetup(installationId: string): Promise<void> {
    return this.codes.void(installationId)
  }

  private async offer(
    installationId: string,
    storeId: string,
    manifest: PluginManifest
  ): Promise<PluginSetupOffer> {
    const { code, expiresAt } = await this.codes.issue({ installationId, storeId })
    return {
      installationId,
      code,
      expiresAt: expiresAt.toISOString(),
      settingsUrl: manifest.ui?.settings ?? null
    }
  }

  // The catalog row of an integration plugin this store may install, with its manifest read again: the row may be stale
  private async load(store: StoreRef, pluginId: string): Promise<IntegrationRow> {
    const plugin = await this.prisma.client.plugin.findUnique({
      where: { id: pluginId },
      select: { type: true, status: true, organizationId: true, manifest: true }
    })
    if (
      plugin === null ||
      plugin.status !== String(PluginStatus.APPROVED) ||
      // An integration plugin, or a remote channel: only a plugin an organization registered has a manifest of its own (the
      // official channels run inside the platform and are installed by the other flow)
      (plugin.type !== String(PluginCatalogTypes.INTEGRATION) &&
        plugin.type !== String(PluginCatalogTypes.CHANNEL)) ||
      // A plugin another organization registered does not exist for this one
      plugin.organizationId !== store.organizationId
    ) {
      throw resourceNotFound('plugin')
    }
    const parsed = pluginManifestSchema.safeParse(plugin.manifest)
    if (!parsed.success) {
      throw new PlatformException(
        ErrorCodes.PLUGIN_INSTALLATION_FAILED,
        'the manifest stored for this plugin is not valid',
        HttpStatusCodes.CONFLICT
      )
    }
    return { manifest: parsed.data }
  }

  private record(
    action:
      | typeof AuditAction.PLUGIN_INSTALLED
      | typeof AuditAction.PLUGIN_SETUP_CODE_ISSUED
      | typeof AuditAction.PLUGIN_SCOPES_UPDATED,
    storeId: string,
    installationId: string,
    actor: Actor,
    metadata: Record<string, unknown>
  ): void {
    // Never the code: only which installation it was issued for
    this.audit.log({
      action,
      actor: { userId: actor.userId },
      storeId,
      resourceType: PLUGIN_INSTALLATION_RESOURCE_TYPE,
      resourceId: installationId,
      metadata,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
  }
}

function alreadyInstalled(): PlatformException {
  return new PlatformException(
    ErrorCodes.PLUGIN_ALREADY_INSTALLED,
    'the plugin is already installed in this store',
    HttpStatusCodes.CONFLICT
  )
}
