import { CredentialCipher } from '@platform/core/crypto'
import { ErrorCodes } from '@platform/core/errors'
import { PluginError } from '@platform/plugins/sdk'

import { ChannelContextFactory, CredentialsUnreadableError } from './channel-context.factory'

const sealer = new CredentialCipher(Buffer.alloc(32, 1))
const reader = new CredentialCipher(Buffer.alloc(32, 2))

const rowSealedWith = (cipher: CredentialCipher, credentials: Record<string, unknown>) => ({
  id: 'row-1',
  storeId: 'store-1',
  pluginId: 'plugin-1',
  connectionId: 'acct-1',
  status: 'active',
  credentials: cipher.seal(credentials),
  metadata: {}
})

describe('ChannelContextFactory', () => {
  it('opens the credentials sealed with its own key', () => {
    const context = new ChannelContextFactory(sealer).contextFor(
      rowSealedWith(sealer, { token: 't' })
    )

    expect(context.credentials).toEqual({ token: 't' })
    expect(context.storeId).toBe('store-1')
  })

  it('refuses credentials sealed with another key as unreadable, saying nothing of the cipher', () => {
    const factory = new ChannelContextFactory(reader)

    let thrown: unknown
    try {
      factory.contextFor(rowSealedWith(sealer, { token: 'secret-token' }))
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(CredentialsUnreadableError)
    // A plugin error, retried like any other and given up on the last attempt (a worker with another
    // key for a while must not lose the messages)
    expect(thrown).toBeInstanceOf(PluginError)
    expect(thrown).toMatchObject({
      code: ErrorCodes.CHANNEL_CREDENTIALS_INVALID,
      retryable: true
    })
    expect(String((thrown as Error).message)).not.toMatch(/decrypt|key|secret-token/)
  })

  it('refuses a row that is not credentials at all', () => {
    const factory = new ChannelContextFactory(sealer)
    const row = { ...rowSealedWith(sealer, {}), credentials: new Uint8Array([1, 2, 3]) }

    expect(() => factory.contextFor(row)).toThrow(CredentialsUnreadableError)
  })
})
