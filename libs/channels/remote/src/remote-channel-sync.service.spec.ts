import type { PinoLogger } from 'nestjs-pino'

import { CredentialCipher, parseEncryptionKey } from '@platform/core/crypto'
import {
  JobContextGoneError,
  type JobContext,
  type PrismaService,
  type WorkerLists
} from '@platform/core/database'
import { PLUGINS_CHANGED_CHANNEL, RemoteChannelLimits } from '@platform/core/domain'
import { PluginRegistry } from '@platform/plugins/runtime'

import { RemoteChannelSync } from './remote-channel-sync.service'
import { COMMAND_SECRET_FIELD } from './remote-command-secret'

const KEY = parseEncryptionKey('ab'.repeat(32))
const cipher = new CredentialCipher(KEY)
const seal = (secret: string): Uint8Array => cipher.seal({ [COMMAND_SECRET_FIELD]: secret })

const logger = {
  setContext: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
} as unknown as PinoLogger

function manifestOf(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    version: '1.0.0',
    name: id,
    description: 'a channel',
    author: { name: 'Acme', email: 'dev@acme.com' },
    type: 'channel',
    pricing: { model: 'free' },
    capabilities: ['text'],
    channel: { label: 'Acme', commandsUrl: 'https://acme.com/commands' },
    scopes: ['channel:connections', 'channel:events'],
    ...extra
  }
}

interface Row {
  id?: string
  manifest: unknown
  installations: { storeId: string }[]
}

function setup(initial: Row[] = []) {
  const state = {
    rows: initial,
    installation: null as null | {
      commandSecret: Uint8Array | null
      commandSecretPrevious: Uint8Array | null
      commandSecretRotatedAt: Date | null
    },
    reads: 0,
    secretReads: 0,
    failList: false,
    storeGone: false,
    filters: [] as unknown[],
    contexts: [] as string[]
  }
  const prisma = {
    client: {
      pluginInstallation: {
        findFirst: jest.fn(() => {
          state.secretReads += 1
          return Promise.resolve(state.installation)
        })
      }
    }
  } as unknown as PrismaService
  // The list of the database (a definer: it sees every store with no context) and the context of the store a secret is read in
  const lists = {
    remoteChannelPlugins: jest.fn((filter: unknown) => {
      state.reads += 1
      state.filters.push(filter)
      return state.failList
        ? Promise.reject(new Error('db down'))
        : Promise.resolve(
            state.rows.map(row => ({
              id: row.id ?? '',
              manifest: row.manifest,
              storeIds: row.installations.map(installation => installation.storeId)
            }))
          )
    })
  } as unknown as WorkerLists
  const jobs = {
    forStoreOrJoin: jest.fn(<T>(storeId: string, work: () => Promise<T>) => {
      state.contexts.push(storeId)
      return state.storeGone ? Promise.reject(new JobContextGoneError('gone')) : work()
    })
  } as unknown as JobContext
  const published: string[] = []
  const handlers: Record<string, (channel: string) => void> = {}
  const subscriber = {
    on: jest.fn((event: string, handler: (channel: string) => void) => {
      handlers[event] = handler
    }),
    subscribe: jest.fn(() => Promise.resolve(1)),
    disconnect: jest.fn()
  }
  const redis = {
    duplicate: () => subscriber,
    publish: jest.fn((channel: string) => {
      published.push(channel)
      return Promise.resolve(1)
    })
  }
  const registry = new PluginRegistry(logger)
  const sync = new RemoteChannelSync(
    prisma,
    lists,
    jobs,
    cipher,
    registry,
    redis as unknown as ConstructorParameters<typeof RemoteChannelSync>[5],
    logger
  )
  return { sync, registry, state, published, handlers, subscriber, redis }
}

describe('RemoteChannelSync: the registry of remote plugins', () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  it('registers each plugin that has an active installation, private to the stores that installed it', async () => {
    const { sync, registry } = setup([
      {
        id: 'acme_chat',
        manifest: manifestOf('acme_chat'),
        installations: [{ storeId: 's1' }, { storeId: 's2' }]
      }
    ])
    await sync.refresh()
    expect(registry.isRemote('acme_chat')).toBe(true)
    expect(registry.isVisibleTo('acme_chat', 's1')).toBe(true)
    expect(registry.isVisibleTo('acme_chat', 's2')).toBe(true)
    expect(registry.isVisibleTo('acme_chat', 's3')).toBe(false)
    expect(registry.list('s3').map(plugin => plugin.id)).not.toContain('acme_chat')
  })

  it('replaces the adapter when the manifest changes and removes it when nobody has it installed', async () => {
    const { sync, registry, state } = setup([
      { id: 'acme_chat', manifest: manifestOf('acme_chat'), installations: [{ storeId: 's1' }] }
    ])
    await sync.refresh()
    expect(registry.get('acme_chat').version).toBe('1.0.0')
    state.rows = [
      {
        id: 'acme_chat',
        manifest: manifestOf('acme_chat', { version: '1.1.0' }),
        installations: [{ storeId: 's1' }]
      }
    ]
    await sync.refresh()
    expect(registry.get('acme_chat').version).toBe('1.1.0')
    state.rows = []
    await sync.refresh()
    expect(registry.has('acme_chat')).toBe(false)
  })

  it('leaves out a stored manifest that is not valid and keeps the others', async () => {
    const { sync, registry } = setup([
      { id: 'broken', manifest: { id: 'broken' }, installations: [{ storeId: 's1' }] },
      { id: 'acme_chat', manifest: manifestOf('acme_chat'), installations: [{ storeId: 's1' }] }
    ])
    await sync.refresh()
    expect(registry.has('broken')).toBe(false)
    expect(registry.has('acme_chat')).toBe(true)
  })

  it('keeps the working adapter when its stored manifest stops reading, and does not build an unchanged one again', async () => {
    const { sync, registry, state } = setup([
      { id: 'acme_chat', manifest: manifestOf('acme_chat'), installations: [{ storeId: 's1' }] }
    ])
    await sync.refresh()
    const first = registry.get('acme_chat')
    await sync.refresh()
    expect(registry.get('acme_chat')).toBe(first)
    state.rows = [
      { id: 'acme_chat', manifest: { id: 'acme_chat' }, installations: [{ storeId: 's1' }] }
    ]
    await sync.refresh()
    expect(registry.get('acme_chat')).toBe(first)
  })

  it('does not subscribe twice while a subscription is pending, nor after it was destroyed', async () => {
    const { sync, subscriber } = setup()
    let release: () => void = () => undefined
    subscriber.subscribe.mockImplementationOnce(
      () => new Promise<number>(resolve => (release = () => resolve(1)))
    )
    const first = (sync as unknown as { subscribe(): Promise<void> }).subscribe()
    await (sync as unknown as { subscribe(): Promise<void> }).subscribe()
    expect(subscriber.subscribe).toHaveBeenCalledTimes(1)
    sync.onModuleDestroy()
    release()
    await first
    expect(subscriber.disconnect).toHaveBeenCalled()
  })

  it('keeps what it had when the read fails: a failed read is not "nobody has it installed"', async () => {
    const { sync, registry, state } = setup([
      { id: 'acme_chat', manifest: manifestOf('acme_chat'), installations: [{ storeId: 's1' }] }
    ])
    await sync.refresh()
    state.failList = true
    await expect(sync.refresh()).resolves.toBeUndefined()
    expect(registry.has('acme_chat')).toBe(true)
  })

  it('reads again when a change arrives during a read, so the last change is never missed', async () => {
    const { sync, state } = setup()
    const first = sync.refresh()
    const second = sync.refresh()
    await Promise.all([first, second])
    expect(state.reads).toBe(2)
  })

  it('reads at start, hears the Redis channel and reads again every 60 seconds', async () => {
    jest.useFakeTimers()
    const { sync, state, handlers, subscriber } = setup()
    await sync.onModuleInit()
    expect(state.reads).toBe(1)
    expect(subscriber.subscribe).toHaveBeenCalledWith(PLUGINS_CHANGED_CHANNEL)
    handlers['message']?.('some:other:channel')
    await Promise.resolve()
    expect(state.reads).toBe(1)
    handlers['message']?.(PLUGINS_CHANGED_CHANNEL)
    await jest.advanceTimersByTimeAsync(0)
    expect(state.reads).toBe(2)
    await jest.advanceTimersByTimeAsync(RemoteChannelLimits.REREAD_INTERVAL_SECONDS * 1000)
    expect(state.reads).toBe(3)
    sync.onModuleDestroy()
    expect(subscriber.disconnect).toHaveBeenCalled()
    await jest.advanceTimersByTimeAsync(RemoteChannelLimits.REREAD_INTERVAL_SECONDS * 2000)
    expect(state.reads).toBe(3)
  })

  it('announces a change on the channel and reads at once itself, whether or not Redis took it', async () => {
    const { sync, published, redis, state } = setup()
    await sync.announceChange()
    expect(published).toEqual([PLUGINS_CHANGED_CHANNEL])
    expect(state.reads).toBe(1)
    redis.publish.mockRejectedValueOnce(new Error('down'))
    await sync.announceChange()
    expect(state.reads).toBe(2)
  })

  it('subscribes before its first read, and tries again on the interval when the subscription failed', async () => {
    jest.useFakeTimers()
    const { sync, subscriber, state } = setup()
    const order: string[] = []
    subscriber.subscribe.mockImplementationOnce(() => {
      order.push(`subscribe-failed:${state.reads}`)
      return Promise.reject(new Error('not ready'))
    })
    await sync.onModuleInit()
    expect(order).toEqual(['subscribe-failed:0'])
    expect(subscriber.disconnect).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(RemoteChannelLimits.REREAD_INTERVAL_SECONDS * 1000)
    expect(subscriber.subscribe).toHaveBeenCalledTimes(2)
    sync.onModuleDestroy()
  })

  it('does not keep in the cache an answer that a change overtook while it was read', async () => {
    const { sync, state } = setup()
    state.installation = {
      commandSecret: seal('old'),
      commandSecretPrevious: null,
      commandSecretRotatedAt: null
    }
    const prisma = (sync as unknown as { prisma: PrismaService }).prisma
    const findFirst = prisma.client.pluginInstallation.findFirst as jest.Mock
    findFirst.mockImplementationOnce(async () => {
      const stale = state.installation
      await sync.refresh()
      return stale
    })
    await sync.secretsOf('s1', 'acme_chat')
    state.installation = {
      commandSecret: seal('new'),
      commandSecretPrevious: null,
      commandSecretRotatedAt: null
    }
    await expect(sync.secretsOf('s1', 'acme_chat')).resolves.toMatchObject({ current: 'new' })
  })

  it('reads the secrets of a revoked installation only for the disconnect', async () => {
    const { sync, state } = setup()
    state.installation = {
      commandSecret: seal('a'),
      commandSecretPrevious: null,
      commandSecretRotatedAt: null
    }
    await sync.secretsForDisconnect('s1', 'acme_chat')
    const prisma = (sync as unknown as { prisma: PrismaService }).prisma
    const findFirst = prisma.client.pluginInstallation.findFirst as jest.Mock
    expect((findFirst.mock.calls[0] as unknown[])[0]).toMatchObject({
      where: { status: { in: ['active', 'revoked'] } }
    })
  })
})

describe('RemoteChannelSync: the secrets of the commands', () => {
  it('opens the current and the previous secret of the active installation of that store', async () => {
    const { sync, state } = setup()
    const rotatedAt = new Date()
    state.installation = {
      commandSecret: seal('new'),
      commandSecretPrevious: seal('old'),
      commandSecretRotatedAt: rotatedAt
    }
    await expect(sync.secretsOf('s1', 'acme_chat')).resolves.toEqual({
      current: 'new',
      previous: 'old',
      rotatedAt
    })
  })

  it('answers null for an installation that is not active, has no secret or whose secret cannot be opened', async () => {
    const { sync, state } = setup()
    state.installation = null
    await expect(sync.secretsOf('s1', 'acme_chat')).resolves.toBeNull()
    state.installation = {
      commandSecret: null,
      commandSecretPrevious: null,
      commandSecretRotatedAt: null
    }
    await expect(sync.secretsOf('s2', 'acme_chat')).resolves.toBeNull()
    state.installation = {
      commandSecret: new CredentialCipher(parseEncryptionKey('cd'.repeat(32))).seal({
        [COMMAND_SECRET_FIELD]: 'x'
      }),
      commandSecretPrevious: null,
      commandSecretRotatedAt: null
    }
    // Not "not installed": a send is tried again (a worker with another key during a deploy)
    await expect(sync.secretsOf('s3', 'acme_chat')).rejects.toMatchObject({ retryable: true })
  })

  it('reads through a cache of 60 seconds that a new read of the plugins clears', async () => {
    const { sync, state } = setup()
    state.installation = {
      commandSecret: seal('a'),
      commandSecretPrevious: null,
      commandSecretRotatedAt: null
    }
    await sync.secretsOf('s1', 'acme_chat')
    await sync.secretsOf('s1', 'acme_chat')
    expect(state.secretReads).toBe(1)
    await sync.secretsOf('s2', 'acme_chat')
    expect(state.secretReads).toBe(2)
    await sync.refresh()
    await sync.secretsOf('s1', 'acme_chat')
    expect(state.secretReads).toBe(3)
  })

  it('asks for the store of the call and nothing else', async () => {
    const { sync, state } = setup()
    state.installation = null
    await sync.secretsOf('store-A', 'acme_chat')
    const prisma = (sync as unknown as { prisma: PrismaService }).prisma
    const findFirst = prisma.client.pluginInstallation.findFirst as jest.Mock
    expect((findFirst.mock.calls[0] as unknown[])[0]).toMatchObject({
      where: {
        storeId: 'store-A',
        pluginId: 'acme_chat',
        status: { in: ['active'] },
        plugin: { status: 'approved' }
      }
    })
  })
  it('lists the plugins through the definer with the filters of the registry, not through a query that row security would empty', async () => {
    const { sync, state } = setup([
      { id: 'acme_chat', manifest: manifestOf('acme_chat'), installations: [{ storeId: 's1' }] }
    ])
    await sync.refresh()
    expect(state.filters).toEqual([
      { type: 'channel', status: 'approved', installationStatus: 'active' }
    ])
    const prisma = (sync as unknown as { prisma: PrismaService }).prisma
    expect(prisma.client).not.toHaveProperty('plugin')
  })

  it('reads the secrets of a store in the context of THAT store, and answers null when the store is gone', async () => {
    const { sync, state } = setup()
    state.installation = {
      commandSecret: seal('s3cret'),
      commandSecretPrevious: null,
      commandSecretRotatedAt: null
    }
    await expect(sync.secretsOf('store-b', 'acme_chat')).resolves.toMatchObject({
      current: 's3cret'
    })
    await expect(sync.secretsForDisconnect('store-c', 'acme_chat')).resolves.toMatchObject({
      current: 's3cret'
    })
    expect(state.contexts).toEqual(['store-b', 'store-c'])
    state.storeGone = true
    await expect(sync.secretsForDisconnect('store-d', 'acme_chat')).resolves.toBeNull()
  })
})
