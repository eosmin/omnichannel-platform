import { isDeepStrictEqual } from 'node:util'

import { Injectable } from '@nestjs/common'
import { z } from 'zod'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { isUniqueViolation, PrismaService } from '@platform/core/database'
import {
  isOfficialChannelId,
  PluginCatalogTypes,
  PluginPricingModels,
  PluginRegistrationLimits,
  PluginStatus,
  ShippingPlugin
} from '@platform/core/domain'
import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'
import {
  CarrierRegistry,
  isNewerVersion,
  type PluginManifest,
  PluginRegistry
} from '@platform/plugins/runtime'

import type { Actor } from '../tenancy'

import { PluginIconService } from './plugin-icon.service'
import type { PluginStoreRef } from './plugin-installations.service'

// What the owner gets back from registering a manifest. The manifest itself is not repeated: they just sent it.
export interface RegisteredPlugin {
  id: string
  name: string
  version: string
  status: string
  // How the id stood: new, replaced by a higher version of the organization's own plugin, or sent again exactly as stored
  outcome: RegistrationOutcome
}

export const RegistrationOutcomes = {
  CREATED: 'created',
  UPDATED: 'updated',
  UNCHANGED: 'unchanged'
} as const
export type RegistrationOutcome = (typeof RegistrationOutcomes)[keyof typeof RegistrationOutcomes]

interface WriteResult {
  outcome: RegistrationOutcome
  previousVersion: string | null
  status: string
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

// What the column keeps: the manifest the schema produced, as plain JSON (a key left undefined is not stored)
function storedManifest(manifest: PluginManifest): { [key: string]: JsonValue } {
  return JSON.parse(JSON.stringify(manifest)) as { [key: string]: JsonValue }
}

const storedVersionSchema = z.object({ version: z.string() })
const storedIconSchema = z.object({ icon: z.string().optional() })

function alreadyRegistered(message: string): PlatformException {
  return new PlatformException(
    ErrorCodes.PLUGIN_ALREADY_REGISTERED,
    message,
    HttpStatusCodes.CONFLICT
  )
}

// Private registration (D10): the owner pastes the manifest of an integration plugin and it becomes a row of the
// catalog that belongs to their organization. No marketplace: the row is approved, free and not official. What it
// cannot do: take an id the platform or another organization holds, or change what an installation was granted
// (the installations keep the scopes they were installed with; a newer manifest that asks for more waits for the
// consent of Step 5.6, PR P2).
@Injectable()
export class PluginRegistrationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: PluginRegistry,
    private readonly carriers: CarrierRegistry,
    private readonly audit: AuditService,
    private readonly icons: PluginIconService
  ) {}

  async register(
    store: PluginStoreRef,
    manifest: PluginManifest,
    actor: Actor
  ): Promise<RegisteredPlugin> {
    // The ids the platform's own code answers for: the official channels, the shipping entry, the ids it defines for a
    // carrier (loaded or not: a route of a webhook names the id) and whatever the registry runs
    if (
      isOfficialChannelId(manifest.id) ||
      manifest.id === ShippingPlugin.ID ||
      this.carriers.knows(manifest.id) ||
      (this.registry.has(manifest.id) && !this.registry.isRemote(manifest.id))
    ) {
      throw alreadyRegistered('that plugin id belongs to the platform')
    }

    // The icon of a channel plugin is fetched before anything is written (the network is never asked inside a transaction)
    // and stored after the row is committed and the id is known to be this organization's: a key of the platform for an id
    // another organization holds is never written
    const icon = await this.iconToFetch(store, manifest)

    const write = () => this.write(store, manifest)
    let result: WriteResult
    try {
      result = await write()
    } catch (error) {
      // Two registrations of the same id at once: the second one finds the first one's row and decides again
      if (!isUniqueViolation(error)) throw error
      result = await write()
    }

    const view: RegisteredPlugin = {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      status: result.status,
      outcome: result.outcome
    }
    // Sent again as it is stored (a retry whose answer was lost): the same answer, and nothing written or audited. The
    // picture may still be missing (an earlier store failed): it is kept now.
    if (result.outcome === RegistrationOutcomes.UNCHANGED) {
      if (icon !== null) await this.keepIcon(manifest.id, icon)
      return view
    }
    this.audit.log({
      action:
        result.outcome === RegistrationOutcomes.UPDATED
          ? AuditAction.PLUGIN_MANIFEST_UPDATED
          : AuditAction.PLUGIN_REGISTERED,
      actor: { userId: actor.userId },
      storeId: store.id,
      resourceType: 'plugin',
      resourceId: manifest.id,
      // What was asked for, so that a version that asks for more than the last one can be seen in the log
      metadata: {
        pluginId: manifest.id,
        version: manifest.version,
        previousVersion: result.previousVersion,
        scopes: manifest.scopes
      },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    // After the audit: the row is committed and the registration happened, whatever becomes of the picture
    if (icon !== null) await this.keepIcon(manifest.id, icon)
    return view
  }

  // The picture of the icon of a channel plugin when it has to be fetched: the plugin declares one, and it is a new address or
  // there is no stored picture yet. Whoever the id belongs to is decided later, by the write; an id that is not this
  // organization's is fetched at most once per attempt and never stored.
  private async iconToFetch(
    store: PluginStoreRef,
    manifest: PluginManifest
  ): Promise<Buffer | null> {
    if (manifest.type !== PluginCatalogTypes.CHANNEL || manifest.icon === undefined) return null
    const existing = await this.prisma.client.plugin.findUnique({
      where: { id: manifest.id },
      select: { organizationId: true, iconKey: true, manifest: true }
    })
    if (existing !== null && existing.organizationId !== store.organizationId) return null
    const stored = storedIconSchema.safeParse(existing?.manifest)
    if (existing?.iconKey != null && stored.success && stored.data.icon === manifest.icon) {
      return null
    }
    return this.icons.fetch(manifest.icon)
  }

  private async keepIcon(pluginId: string, png: Buffer): Promise<void> {
    let key: string
    try {
      key = await this.icons.store(pluginId, png)
    } catch {
      throw new PlatformException(
        ErrorCodes.PLUGIN_ICON_INVALID,
        'the icon could not be kept, register the plugin again',
        HttpStatusCodes.SERVICE_UNAVAILABLE
      )
    }
    await this.prisma.client.plugin.update({ where: { id: pluginId }, data: { iconKey: key } })
  }

  private write(store: PluginStoreRef, manifest: PluginManifest): Promise<WriteResult> {
    return this.prisma.transaction(async tx => {
      // One registration at a time per organization, so that the limit below holds when two stores of it register together
      await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${store.organizationId} FOR UPDATE`
      const existing = await tx.plugin.findUnique({
        where: { id: manifest.id },
        select: { organizationId: true, isOfficial: true, type: true, status: true, manifest: true }
      })
      const stored = storedManifest(manifest)
      const data = {
        name: manifest.name,
        authorName: manifest.author.name,
        authorEmail: manifest.author.email,
        manifest: stored
      }

      if (existing === null) {
        const count = await tx.plugin.count({ where: { organizationId: store.organizationId } })
        if (count >= PluginRegistrationLimits.MAX_PER_ORGANIZATION) {
          throw new PlatformException(
            ErrorCodes.PLUGIN_LIMIT_REACHED,
            'the organization has registered as many plugins as it may',
            HttpStatusCodes.CONFLICT
          )
        }
        await tx.plugin.create({
          data: {
            id: manifest.id,
            ...data,
            type: manifest.type,
            isOfficial: false,
            pricingModel: PluginPricingModels.FREE,
            status: PluginStatus.APPROVED,
            organizationId: store.organizationId
          }
        })
        return {
          outcome: RegistrationOutcomes.CREATED,
          previousVersion: null,
          status: String(PluginStatus.APPROVED)
        }
      }

      // The id is somebody's: another organization's, or the platform's. The answer is the same for both.
      if (
        existing.organizationId !== store.organizationId ||
        existing.isOfficial ||
        // A plugin does not change what it is: an integration stays one and a channel stays one
        existing.type !== manifest.type
      ) {
        throw alreadyRegistered('that plugin id is taken')
      }
      const storedVersion = storedVersionSchema.safeParse(existing.manifest)
      // A row whose manifest has no version is not one this code wrote: it is not replaced, whatever comes
      if (!storedVersion.success)
        throw alreadyRegistered('the registered manifest of that plugin cannot be read')
      const previousVersion = storedVersion.data.version
      if (isDeepStrictEqual(stored, existing.manifest)) {
        return { outcome: RegistrationOutcomes.UNCHANGED, previousVersion, status: existing.status }
      }
      // A suspended plugin is not edited: what its manifest says is what it was suspended with
      if (existing.status !== String(PluginStatus.APPROVED)) {
        throw alreadyRegistered('that plugin is not active and cannot be changed')
      }
      if (!isNewerVersion(manifest.version, previousVersion)) {
        throw alreadyRegistered(
          'a manifest of this plugin with that version or a newer one is already registered'
        )
      }
      // The pricing, the owner organization and the installations are not touched. A picture whose address changed is
      // not kept: until the new one is stored there is none, so the old one is never shown for the new address.
      const iconChanged = storedIconSchema.safeParse(existing.manifest).data?.icon !== manifest.icon
      await tx.plugin.update({
        where: { id: manifest.id },
        data: iconChanged ? { ...data, iconKey: null } : data
      })
      return { outcome: RegistrationOutcomes.UPDATED, previousVersion, status: existing.status }
    })
  }
}
