import { ChannelConnectionStatus, RemoteChannelApiLimits } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { ChannelDisconnectedReasons, Events } from '@platform/core/events'

import { PluginChannelConnectionsService } from './plugin-channel-connections.service'

jest.mock('@platform/core/database', () => ({
  ...jest.requireActual<object>('@platform/core/database'),
  lockStoreForWrite: jest.fn().mockResolvedValue(undefined)
}))

// `expect.objectContaining` is typed `any`: said once, as what it is
const like = (value: object): object => expect.objectContaining(value) as object

const STORE = '00000000-0000-4000-8000-000000000001'
const OTHER_STORE = '00000000-0000-4000-8000-000000000002'
const INSTALLATION = '00000000-0000-4000-8000-0000000000a1'
const OTHER_INSTALLATION = '00000000-0000-4000-8000-0000000000a2'
const ROW = '00000000-0000-4000-8000-0000000000c1'
const PLUGIN = 'acme-chat'
const caller = { installationId: INSTALLATION, pluginId: PLUGIN, storeId: STORE }
const actor = {
  userId: `plugin:${INSTALLATION}`,
  storeId: STORE,
  pluginInstallationId: INSTALLATION
}
const body = { displayName: 'Main line' }

interface Tx {
  pluginInstallation: { findFirst: jest.Mock }
  channelConnection: {
    findUnique: jest.Mock
    findFirst: jest.Mock
    count: jest.Mock
    create: jest.Mock
    update: jest.Mock
    updateMany: jest.Mock
  }
}

function build(): {
  service: PluginChannelConnectionsService
  tx: Tx
  publish: jest.Mock
  log: jest.Mock
} {
  const tx: Tx = {
    pluginInstallation: { findFirst: jest.fn().mockResolvedValue({ id: INSTALLATION }) },
    channelConnection: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({ id: ROW }),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 })
    }
  }
  const publish = jest.fn()
  const log = jest.fn()
  const service = new PluginChannelConnectionsService(
    { transaction: (work: (tx: Tx) => unknown) => work(tx) } as never,
    { seal: jest.fn(() => Buffer.from('sealed-empty')) } as never,
    { log } as never,
    { publish } as never
  )
  return { service, tx, publish, log }
}

describe('PluginChannelConnectionsService.put', () => {
  it('creates the connection of the installation, with empty credentials, and says it is new', async () => {
    const { service, tx, publish, log } = build()

    await expect(
      service.put(caller, 'acct-1', { ...body, metadata: { a: 1 } }, actor)
    ).resolves.toBe(true)

    expect(tx.channelConnection.create).toHaveBeenCalledWith({
      data: like({
        storeId: STORE,
        pluginId: PLUGIN,
        connectionId: 'acct-1',
        installationId: INSTALLATION,
        displayName: 'Main line',
        status: ChannelConnectionStatus.ACTIVE,
        credentials: Buffer.from('sealed-empty'),
        metadata: { a: 1 }
      }),
      select: { id: true }
    })
    expect(publish).toHaveBeenCalledWith(tx, Events.CHANNEL_CONNECTED, {
      storeId: STORE,
      channelConnectionId: ROW,
      pluginId: PLUGIN
    })
    // A plugin is the system in the audit log, with its installation in the metadata
    expect(log).toHaveBeenCalledWith(
      like({
        actor: { system: true },
        storeId: STORE,
        resourceId: ROW,
        metadata: { pluginId: PLUGIN, pluginInstallationId: INSTALLATION }
      })
    )
  })

  it('reads the installation again inside the transaction, bound to the store, the plugin and its channel type', async () => {
    const { service, tx } = build()
    await service.put(caller, 'acct-1', body, actor)
    expect(tx.pluginInstallation.findFirst).toHaveBeenCalledWith({
      where: like({ id: INSTALLATION, storeId: STORE, pluginId: PLUGIN }),
      select: { id: true }
    })
  })

  it('refuses with 401 when the installation was revoked a moment ago, and writes nothing', async () => {
    const { service, tx } = build()
    tx.pluginInstallation.findFirst.mockResolvedValue(null)
    await expect(service.put(caller, 'acct-1', body, actor)).rejects.toMatchObject({
      code: ErrorCodes.PLUGIN_API_KEY_INVALID
    })
    expect(tx.channelConnection.create).not.toHaveBeenCalled()
  })

  it('updates the name and the data of its own live connection (200) and fires no connected event', async () => {
    const { service, tx, publish } = build()
    tx.channelConnection.findUnique.mockResolvedValue({
      id: ROW,
      storeId: STORE,
      installationId: INSTALLATION,
      status: ChannelConnectionStatus.ACTIVE
    })
    await expect(service.put(caller, 'acct-1', body, actor)).resolves.toBe(false)
    expect(tx.channelConnection.update).toHaveBeenCalledWith({
      where: { id: ROW },
      data: { displayName: 'Main line' }
    })
    expect(publish).not.toHaveBeenCalled()
    expect(tx.channelConnection.count).not.toHaveBeenCalled()
  })

  it('does not take a connection that is in ERROR out of it by writing its name', async () => {
    const { service, tx } = build()
    tx.channelConnection.findUnique.mockResolvedValue({
      id: ROW,
      storeId: STORE,
      installationId: INSTALLATION,
      status: ChannelConnectionStatus.ERROR
    })
    await service.put(caller, 'acct-1', body, actor)
    const data = (tx.channelConnection.update.mock.calls[0] as [{ data: object }])[0].data
    expect(data).not.toHaveProperty('status')
  })

  it('reactivates a disconnected connection of this store (200) and says it connected', async () => {
    const { service, tx, publish } = build()
    tx.channelConnection.findUnique.mockResolvedValue({
      id: ROW,
      storeId: STORE,
      installationId: OTHER_INSTALLATION,
      status: ChannelConnectionStatus.DISCONNECTED
    })
    await expect(service.put(caller, 'acct-1', body, actor)).resolves.toBe(false)
    expect(tx.channelConnection.update).toHaveBeenCalledWith({
      where: { id: ROW },
      data: like({
        status: ChannelConnectionStatus.ACTIVE,
        installationId: INSTALLATION,
        lastError: null
      })
    })
    expect(publish).toHaveBeenCalledWith(tx, Events.CHANNEL_CONNECTED, expect.any(Object))
  })

  it('answers 409 when the account is linked to another store, whatever its state, and writes nothing', async () => {
    for (const status of [ChannelConnectionStatus.ACTIVE, ChannelConnectionStatus.DISCONNECTED]) {
      const { service, tx } = build()
      tx.channelConnection.findUnique.mockResolvedValue({
        id: ROW,
        storeId: OTHER_STORE,
        installationId: OTHER_INSTALLATION,
        status
      })
      await expect(service.put(caller, 'acct-1', body, actor)).rejects.toMatchObject({
        code: ErrorCodes.RESOURCE_CONFLICT
      })
      expect(tx.channelConnection.update).not.toHaveBeenCalled()
      expect(tx.channelConnection.create).not.toHaveBeenCalled()
    }
  })

  it('answers 409 for a live connection of this store that hangs from another installation, and never names whose', async () => {
    const { service, tx } = build()
    tx.channelConnection.findUnique.mockResolvedValue({
      id: ROW,
      storeId: STORE,
      installationId: OTHER_INSTALLATION,
      status: ChannelConnectionStatus.ACTIVE
    })
    const failure = await service
      .put(caller, 'acct-1', body, actor)
      .catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: ErrorCodes.RESOURCE_CONFLICT })
    expect(JSON.stringify(failure)).not.toContain(OTHER_INSTALLATION)
    expect(tx.channelConnection.update).not.toHaveBeenCalled()
  })

  it('counts the connections that are not disconnected, and refuses the 21st with 409', async () => {
    const { service, tx } = build()
    tx.channelConnection.count.mockResolvedValue(RemoteChannelApiLimits.MAX_ACTIVE_CONNECTIONS)
    await expect(service.put(caller, 'acct-21', body, actor)).rejects.toMatchObject({
      code: ErrorCodes.RESOURCE_CONFLICT
    })
    expect(tx.channelConnection.count).toHaveBeenCalledWith({
      where: { installationId: INSTALLATION, status: { not: ChannelConnectionStatus.DISCONNECTED } }
    })
    expect(tx.channelConnection.create).not.toHaveBeenCalled()
  })

  it('takes the 20th', async () => {
    const { service, tx } = build()
    tx.channelConnection.count.mockResolvedValue(RemoteChannelApiLimits.MAX_ACTIVE_CONNECTIONS - 1)
    await expect(service.put(caller, 'acct-20', body, actor)).resolves.toBe(true)
  })

  it('refuses to reactivate past the limit too', async () => {
    const { service, tx } = build()
    tx.channelConnection.findUnique.mockResolvedValue({
      id: ROW,
      storeId: STORE,
      installationId: INSTALLATION,
      status: ChannelConnectionStatus.DISCONNECTED
    })
    tx.channelConnection.count.mockResolvedValue(RemoteChannelApiLimits.MAX_ACTIVE_CONNECTIONS)
    await expect(service.put(caller, 'acct-1', body, actor)).rejects.toMatchObject({
      code: ErrorCodes.RESOURCE_CONFLICT
    })
    expect(tx.channelConnection.update).not.toHaveBeenCalled()
  })

  it('runs again after losing the race for a new account to another store, and then conflicts', async () => {
    const { service, tx } = build()
    tx.channelConnection.create.mockRejectedValueOnce(
      Object.assign(new Error('unique'), { code: 'P2002' })
    )
    tx.channelConnection.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: ROW,
      storeId: OTHER_STORE,
      installationId: OTHER_INSTALLATION,
      status: ChannelConnectionStatus.ACTIVE
    })
    await expect(service.put(caller, 'acct-1', body, actor)).rejects.toMatchObject({
      code: ErrorCodes.RESOURCE_CONFLICT
    })
    expect(tx.channelConnection.findUnique).toHaveBeenCalledTimes(2)
  })

  it('lets any other failure through without a second try', async () => {
    const { service, tx } = build()
    tx.channelConnection.create.mockRejectedValue(new Error('the database is down'))
    await expect(service.put(caller, 'acct-1', body, actor)).rejects.toThrow('the database is down')
    expect(tx.channelConnection.create).toHaveBeenCalledTimes(1)
  })
})

describe('PluginChannelConnectionsService.disconnect', () => {
  it('looks for the connection by plugin, account, store AND installation: a connection of another installation is a 404', async () => {
    const { service, tx, publish } = build()
    await expect(service.disconnect(caller, 'acct-1', actor)).rejects.toMatchObject({
      code: ErrorCodes.CHANNEL_CONNECTION_NOT_FOUND
    })
    expect(tx.channelConnection.findFirst).toHaveBeenCalledWith({
      where: {
        pluginId: PLUGIN,
        connectionId: 'acct-1',
        storeId: STORE,
        installationId: INSTALLATION
      },
      select: { id: true, status: true }
    })
    expect(tx.channelConnection.updateMany).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
  })

  it('sets it DISCONNECTED, empties the credentials, keeps the row and says so', async () => {
    const { service, tx, publish, log } = build()
    tx.channelConnection.findFirst.mockResolvedValue({
      id: ROW,
      status: ChannelConnectionStatus.ACTIVE
    })
    await service.disconnect(caller, 'acct-1', actor)
    expect(tx.channelConnection.updateMany).toHaveBeenCalledWith({
      where: { id: ROW, storeId: STORE, status: { not: ChannelConnectionStatus.DISCONNECTED } },
      data: {
        status: ChannelConnectionStatus.DISCONNECTED,
        credentials: Buffer.from('sealed-empty'),
        lastError: null
      }
    })
    expect(publish).toHaveBeenCalledWith(tx, Events.CHANNEL_DISCONNECTED, {
      storeId: STORE,
      channelConnectionId: ROW,
      pluginId: PLUGIN,
      reason: ChannelDisconnectedReasons.USER
    })
    expect(log).toHaveBeenCalledWith(like({ resourceId: ROW, actor: { system: true } }))
  })

  it('is quiet for a connection that already was disconnected: no event, no audit entry', async () => {
    const { service, tx, publish, log } = build()
    tx.channelConnection.findFirst.mockResolvedValue({
      id: ROW,
      status: ChannelConnectionStatus.DISCONNECTED
    })
    tx.channelConnection.updateMany.mockResolvedValue({ count: 0 })
    await expect(service.disconnect(caller, 'acct-1', actor)).resolves.toBeUndefined()
    expect(publish).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
  })
})
