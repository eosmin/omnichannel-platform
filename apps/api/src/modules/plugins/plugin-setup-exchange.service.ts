import { Injectable } from '@nestjs/common'

import {
  newCommandSecret,
  RemoteChannelSync,
  sealCommandSecret
} from '@platform/channels/connections'
import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { CredentialCipher, generateToken, hashToken } from '@platform/core/crypto'
import { lockStoreForWrite, PrismaService } from '@platform/core/database'
import {
  PLUGIN_API_KEY_TOKEN_PREFIX,
  PLUGIN_INSTALLATION_RESOURCE_TYPE,
  PluginCatalogTypes,
  PluginInstallationStatus,
  PluginInstallLimits,
  PluginStatus,
  WEBHOOK_SECRET_PREFIX,
  WebhookLimits
} from '@platform/core/domain'
import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'

import { knownScopes } from './plugin-install-rules'
import { PluginSetupCodeStore } from './plugin-setup-code.store'

// What the plugin gets back, once: its key, and what the key is for. The key is never returned again, by this route or by any other.
export interface PluginSetupResult {
  apiKey: string
  // The secret that signs the deliveries to the plugin's webhook endpoint (`whsec_...`), shown here once like the key: the platform
  // keeps it sealed and signs with it. Null for a plugin with no webhook endpoint.
  webhookSecret: string | null
  installationId: string
  pluginId: string
  storeId: string
  scopes: string[]
  rateLimitPerMinute: number
  // Only for a remote channel: the secret that signs the commands the platform sends it (TDD_10 §6.7.3). Shown here once, like the key.
  commandSecret?: string
}

function invalidCode(): PlatformException {
  // One answer for a code that is unknown, expired, used, or whose installation is no longer waiting: the call says nothing about
  // which installations exist
  return new PlatformException(
    ErrorCodes.PLUGIN_SETUP_CODE_INVALID,
    'the setup code is not valid',
    HttpStatusCodes.UNAUTHORIZED
  )
}

// The plugin trades its one-time code for its key (TDD_10 §6.3). The code is read and removed in one Redis command, so two
// calls cannot both have it; the key is made now, kept as its prefix and SHA-256 and returned in this answer only; and the
// installation becomes ACTIVE in the same transaction that stores the hash, so there is no moment with a key and a pending
// install, or an active install with no key. A failure after the code was taken costs the owner a new code, never a key that
// is not accounted for.
@Injectable()
export class PluginSetupExchangeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly codes: PluginSetupCodeStore,
    private readonly audit: AuditService,
    private readonly cipher: CredentialCipher,
    private readonly sync: RemoteChannelSync
  ) {}

  async exchange(
    code: string,
    caller: { ipAddress?: string | undefined; userAgent?: string | undefined } = {}
  ): Promise<PluginSetupResult> {
    const record = await this.codes.take(code)
    if (record === null) throw invalidCode()

    const key = `${PLUGIN_API_KEY_TOKEN_PREFIX}${generateToken(PluginInstallLimits.KEY_SECRET_BYTES)}`
    const webhookSecret = `${WEBHOOK_SECRET_PREFIX}${generateToken(WebhookLimits.SECRET_BYTES)}`
    const result = await this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, record.storeId)
      const installation = await tx.pluginInstallation.findFirst({
        // The store of the code and the store of the row must be the same one: a code never opens another store's installation
        where: {
          id: record.installationId,
          storeId: record.storeId,
          status: PluginInstallationStatus.PENDING_SETUP,
          plugin: { status: PluginStatus.APPROVED }
        },
        select: {
          id: true,
          pluginId: true,
          scopes: true,
          rateLimitPerMinute: true,
          webhookEndpoint: true,
          plugin: { select: { type: true } }
        }
      })
      if (installation === null) return null
      // A remote channel also gets the secret of its commands, in the same write that activates it, so there is no active
      // channel without one
      const isChannel = installation.plugin.type === String(PluginCatalogTypes.CHANNEL)
      const commandSecret = isChannel ? newCommandSecret() : null
      const activated = await tx.pluginInstallation.updateMany({
        where: {
          id: installation.id,
          storeId: record.storeId,
          status: PluginInstallationStatus.PENDING_SETUP
        },
        data: {
          status: PluginInstallationStatus.ACTIVE,
          apiKeyPrefix: key.slice(0, PluginInstallLimits.KEY_DISPLAY_PREFIX_LENGTH),
          apiKeyHash: hashToken(key),
          ...(commandSecret === null
            ? {}
            : {
                commandSecret: sealCommandSecret(this.cipher, commandSecret),
                commandSecretPrevious: null,
                commandSecretRotatedAt: null
              }),
          // A plugin with a webhook endpoint gets the secret that signs what is sent to it, and starts with a clean count of
          // failures (an installation that was revoked and installed again must not come back turned off)
          webhookSecret:
            installation.webhookEndpoint === null
              ? null
              : this.cipher.seal({ secret: webhookSecret }),
          webhookConsecutiveFailures: 0,
          webhookLastFailureAt: null,
          webhookDisabledAt: null
        }
      })
      return activated.count === 1 ? { ...installation, commandSecret } : null
    })
    if (result === null) throw invalidCode()

    // Neither the key nor the secret is in the entry: only which installation was set up. The actor is the platform: nobody is signed in.
    this.audit.log({
      action: AuditAction.PLUGIN_SETUP_COMPLETED,
      actor: { system: true },
      storeId: record.storeId,
      resourceType: PLUGIN_INSTALLATION_RESOURCE_TYPE,
      resourceId: result.id,
      metadata: { pluginId: result.pluginId },
      ...(caller.ipAddress === undefined ? {} : { ipAddress: caller.ipAddress }),
      ...(caller.userAgent === undefined ? {} : { userAgent: caller.userAgent })
    })
    // The registries of the other processes learn that a channel came up
    if (result.commandSecret !== null) await this.sync.announceChange()
    return {
      apiKey: key,
      webhookSecret: result.webhookEndpoint === null ? null : webhookSecret,
      installationId: result.id,
      pluginId: result.pluginId,
      storeId: record.storeId,
      scopes: knownScopes(result.scopes),
      rateLimitPerMinute: result.rateLimitPerMinute,
      ...(result.commandSecret === null ? {} : { commandSecret: result.commandSecret })
    }
  }
}
