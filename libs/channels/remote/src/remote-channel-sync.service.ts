import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import type { Redis } from 'ioredis'
import { PinoLogger } from 'nestjs-pino'

import { CredentialCipher } from '@platform/core/crypto'
import {
  JobContext,
  JobContextError,
  JobContextGoneError,
  PrismaService,
  WorkerLists
} from '@platform/core/database'
import {
  PLUGINS_CHANGED_CHANNEL,
  PluginCatalogTypes,
  PluginInstallationStatus,
  PluginStatus,
  RemoteChannelLimits
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { REDIS_CLIENT } from '@platform/core/redis'
import {
  PluginRegistry,
  pluginManifestSchema,
  RemoteChannelPlugin,
  type RemoteCommandSecrets,
  type RemoteSecretSource
} from '@platform/plugins/runtime'
import { PluginError } from '@platform/plugins/sdk'

import { COMMAND_SECRET_FIELD } from './remote-command-secret'

interface Cached {
  value: RemoteCommandSecrets | null
  expiresAt: number
}

// Keeps the remote channel plugins of this process (TDD_10 §6.7.3): the adapter of each plugin that has at least one ACTIVE
// installation, private to the stores that installed it. The api and the worker both run it. It reads everything at start,
// when another process says on `plugins:changed` that something changed (an install, a revoke, a suspension, a new manifest, a
// rotation) and every 60 seconds, in case a message was lost. It is also the source of the secrets the adapter signs with,
// read through a cache of 60 seconds that the same message clears.
@Injectable()
export class RemoteChannelSync implements RemoteSecretSource, OnModuleInit, OnModuleDestroy {
  private readonly cache = new Map<string, Cached>()
  private subscriber: Redis | null = null
  private timer: NodeJS.Timeout | null = null
  private running: Promise<void> | null = null
  private again = false
  private subscribing = false
  private destroyed = false
  // What each plugin was last registered from (its manifest and the stores), so an unchanged one is not built and validated again
  private readonly registered = new Map<string, string>()
  // Bumped whenever the cache is cleared: a read that began before cannot put its answer back
  private generation = 0

  constructor(
    private readonly prisma: PrismaService,
    private readonly lists: WorkerLists,
    private readonly jobs: JobContext,
    private readonly cipher: CredentialCipher,
    private readonly registry: PluginRegistry,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(RemoteChannelSync.name)
  }

  async onModuleInit(): Promise<void> {
    // Subscribed before the first read, so a change announced in between is heard; and tried again on every read of the interval
    // if it failed (a Redis that was not up yet), so a process is never left on the poll alone
    await this.subscribe()
    // A Redis or a database that is down at boot must not stop the process: the next read (or the next message) catches up
    await this.refresh()
    this.timer = setInterval(() => {
      void this.subscribe()
      void this.refresh()
    }, RemoteChannelLimits.REREAD_INTERVAL_SECONDS * 1000)
    this.timer.unref()
  }

  private async subscribe(): Promise<void> {
    if (this.subscriber !== null || this.subscribing || this.destroyed) return
    this.subscribing = true
    try {
      const subscriber = this.redis.duplicate()
      // An error of the connection is logged and the connection retries by itself; the periodic read covers the gap
      subscriber.on('error', error => {
        this.logger.warn({ errorName: error.name }, 'the plugins subscription failed')
      })
      subscriber.on('message', (channel: string) => {
        if (channel === PLUGINS_CHANGED_CHANNEL) void this.refresh()
      })
      try {
        await subscriber.subscribe(PLUGINS_CHANGED_CHANNEL)
      } catch (error) {
        subscriber.disconnect()
        throw error
      }
      if (this.destroyed) {
        subscriber.disconnect()
        return
      }
      this.subscriber = subscriber
    } catch (error) {
      this.logger.warn(
        { errorName: error instanceof Error ? error.name : 'unknown' },
        'could not subscribe to the plugins channel'
      )
    } finally {
      this.subscribing = false
    }
  }

  onModuleDestroy(): void {
    this.destroyed = true
    if (this.timer !== null) clearInterval(this.timer)
    this.subscriber?.disconnect()
    this.subscriber = null
  }

  // Says to every process, this one included, that the remote plugins changed. Best effort, like the rest of the realtime layer:
  // the change is committed already, and the periodic read of the others is the backstop. If Redis does not take it, this
  // process reads at once.
  async announceChange(): Promise<void> {
    try {
      await this.redis.publish(PLUGINS_CHANGED_CHANNEL, '1')
    } catch {
      // Redis did not take it: the others catch up on their read of the interval
    }
    // This process does not wait for its own message: whoever asked (an exchange, a revoke) is answered with the registry already
    // up to date here
    await this.refresh()
  }

  // One read at a time; a change that arrives while one is running makes it run again, so it never misses the last change
  refresh(): Promise<void> {
    if (this.running !== null) {
      this.again = true
      return this.running
    }
    const run = (async (): Promise<void> => {
      do {
        this.again = false
        await this.readAll()
      } while (this.again)
    })().finally(() => {
      this.running = null
    })
    this.running = run
    return run
  }

  async secretsOf(storeId: string, pluginId: string): Promise<RemoteCommandSecrets | null> {
    const key = `${storeId}:${pluginId}`
    const now = Date.now()
    const cached = this.cache.get(key)
    if (cached !== undefined && cached.expiresAt > now) return cached.value
    const generation = this.generation
    const value = await this.readSecrets(storeId, pluginId, [PluginInstallationStatus.ACTIVE])
    // A change that cleared the cache while this read ran made the answer old: it is used once and not kept
    if (generation === this.generation) {
      this.cache.set(key, {
        value,
        expiresAt: now + RemoteChannelLimits.INSTALLATION_CACHE_SECONDS * 1000
      })
    }
    return value
  }

  // For the disconnect that follows an uninstall: the installation is already revoked, and its plugin still has to hear it. Not cached.
  secretsForDisconnect(storeId: string, pluginId: string): Promise<RemoteCommandSecrets | null> {
    return this.readSecrets(storeId, pluginId, [
      PluginInstallationStatus.ACTIVE,
      PluginInstallationStatus.REVOKED
    ])
  }

  private async readSecrets(
    storeId: string,
    pluginId: string,
    statuses: readonly string[]
  ): Promise<RemoteCommandSecrets | null> {
    // In the context of the store of the connection the call is for (the one of the request or the job when it already is that store's),
    // read from the row by the core, never from a request
    const row = await this.jobs
      .forStoreOrJoin(storeId, () =>
        this.prisma.client.pluginInstallation.findFirst({
          where: {
            storeId,
            pluginId,
            status: { in: [...statuses] },
            plugin: { status: PluginStatus.APPROVED }
          },
          select: { commandSecret: true, commandSecretPrevious: true, commandSecretRotatedAt: true }
        })
      )
      // A store deleted while the call was on its way has no installation left
      .catch((error: unknown) => {
        if (error instanceof JobContextGoneError) return null
        throw error
      })
    if (row?.commandSecret == null) return null
    try {
      const open = (sealed: Uint8Array): string => {
        const secret = this.cipher.open(sealed)[COMMAND_SECRET_FIELD]
        if (typeof secret !== 'string' || secret === '') throw new Error('not a secret')
        return secret
      }
      return {
        current: open(row.commandSecret),
        previous: row.commandSecretPrevious == null ? null : open(row.commandSecretPrevious),
        rotatedAt: row.commandSecretRotatedAt
      }
    } catch {
      // Sealed with another key (a worker of a rolling deploy), or damaged: nothing is sent with a secret that cannot be read, and
      // nothing of it is logged. Not "not installed": the send is tried again, as for credentials that cannot be opened.
      this.logger.warn({ pluginId }, 'the command secret of an installation cannot be read')
      throw new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID, { retryable: true })
    }
  }

  // The manifest of a private plugin is the JSON its organization registered: it is read in the context of one of the stores that
  // installed it (the policy of plugins lets that organization read it), never through the list. undefined: could not be read now.
  // When a request opened the refresh (announceChange after an install), the store of that request is the one to read in: forStoreOrJoin
  // joins its context, so the registry of this process is up to date when the request is answered.
  private async manifestOf(pluginId: string, storeIds: readonly string[]): Promise<unknown> {
    const inRequest = this.prisma.currentTenantContext()?.storeIds ?? []
    const storeId = storeIds.find(id => inRequest.includes(id)) ?? storeIds[0]
    if (storeId === undefined) return undefined
    try {
      const row = await this.jobs.forStoreOrJoin(storeId, () =>
        this.prisma.client.plugin.findUnique({
          where: { id: pluginId },
          select: { manifest: true }
        })
      )
      if (row === null) {
        // Hidden from that store (or gone): a plugin that never registers must leave a trace
        this.logger.warn(
          { pluginId, storeId },
          'a remote channel plugin has no manifest for its store'
        )
        return undefined
      }
      return row.manifest
    } catch (error) {
      if (error instanceof JobContextError) {
        this.logger.warn(
          { pluginId, storeId },
          'the manifest of a remote channel plugin could not be read'
        )
        return undefined
      }
      throw error
    }
  }

  private async readAll(): Promise<void> {
    try {
      // Across stores, with no context: the definer of the database lists them (a plain query would answer none under row security)
      const rows = await this.lists.remoteChannelPlugins({
        type: PluginCatalogTypes.CHANNEL,
        status: PluginStatus.APPROVED,
        installationStatus: PluginInstallationStatus.ACTIVE
      })
      const wanted = []
      const untouched = new Set<string>()
      const signatures = new Map<string, string>()
      for (const row of rows) {
        // A plugin of the code that a store installed has no manifest of its own to read (the row holds
        // `{}`): it is not one to build, validate or complain about, and the registry keeps it as it is
        if (this.registry.has(row.id) && !this.registry.isRemote(row.id)) {
          untouched.add(row.id)
          continue
        }
        const storeIds = [...row.storeIds].sort()
        const stored = await this.manifestOf(row.id, storeIds)
        if (stored === undefined) {
          // Not readable now (no store to read it in, a context that refuses): its previous adapter, if any, stays
          untouched.add(row.id)
          continue
        }
        const signature = JSON.stringify([stored, storeIds])
        // Unchanged since it was registered: its adapter stays, and nothing is built, validated or logged for it
        if (this.registered.get(row.id) === signature && this.registry.isRemote(row.id)) {
          untouched.add(row.id)
          signatures.set(row.id, signature)
          continue
        }
        const manifest = pluginManifestSchema.safeParse(stored)
        if (!manifest.success || manifest.data.channel === undefined) {
          // A stored manifest that no longer reads does not take down the adapter that works for the stores that installed it
          this.logger.error(
            { pluginId: row.id },
            'a stored channel manifest is not valid: its previous adapter, if any, stays'
          )
          untouched.add(row.id)
          continue
        }
        signatures.set(row.id, signature)
        wanted.push({
          plugin: new RemoteChannelPlugin(manifest.data, { secrets: this }),
          storeIds
        })
      }
      this.generation += 1
      this.cache.clear()
      const refused = this.registry.syncRemote(wanted, untouched)
      this.registered.clear()
      for (const [id, signature] of signatures) {
        // One the registry refused is tried again at the next read
        if (!refused.includes(id)) this.registered.set(id, signature)
      }
    } catch (error) {
      // The registry keeps what it had: a read that failed is not "nobody has it installed"
      this.logger.error(
        { errorName: error instanceof Error ? error.name : 'unknown' },
        'reading the remote channel plugins failed'
      )
    }
  }
}
