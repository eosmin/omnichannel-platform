// The barrel of connections loads the environment of the app, which a unit run does not have
jest.mock('@platform/channels/connections', () => ({
  errorName: (error: unknown) => (error instanceof Error ? error.name : 'unknown')
}))
jest.mock('@platform/core/messaging', () => ({
  ...jest.requireActual<typeof Messaging>('@platform/core/messaging'),
  lockMessageRow: jest.fn().mockResolvedValue(undefined),
  publishMessageChanged: jest.fn().mockResolvedValue(undefined)
}))

import type * as Messaging from '@platform/core/messaging'
import { lockMessageRow, publishMessageChanged } from '@platform/core/messaging'

import { UnavailableFileMarker } from './unavailable-file-marker.service'

const STORE = '11111111-1111-4111-8111-111111111111'
const MESSAGE = '22222222-2222-4222-8222-222222222222'

function setup(metadata: unknown, found = true) {
  const tx = {
    message: {
      findFirst: jest.fn().mockResolvedValue(found ? { metadata } : null),
      updateMany: jest.fn().mockResolvedValue({ count: 1 })
    }
  }
  const prisma = { transaction: jest.fn((work: (t: typeof tx) => Promise<void>) => work(tx)) }
  const logger = { setContext: jest.fn(), warn: jest.fn() }
  const marker = new UnavailableFileMarker(prisma as never, {} as never, logger as never)
  return { marker, tx, prisma, logger }
}

describe('UnavailableFileMarker', () => {
  beforeEach(() => jest.clearAllMocks())

  it('adds the file to the metadata the channel left, locks the row and tells the team', async () => {
    const { marker, tx } = setup({ attachmentUrl: 'https://example.com/a' })

    await marker.mark(STORE, MESSAGE, 1, 'refused')

    expect(lockMessageRow).toHaveBeenCalledWith(tx, MESSAGE)
    expect(tx.message.updateMany).toHaveBeenCalledWith({
      where: { id: MESSAGE, storeId: STORE },
      data: {
        metadata: {
          attachmentUrl: 'https://example.com/a',
          unavailableFiles: [{ index: 1, code: 'refused' }]
        }
      }
    })
    expect(publishMessageChanged).toHaveBeenCalledWith(
      expect.anything(),
      tx,
      'media.unavailable',
      STORE,
      MESSAGE
    )
  })

  it('keeps the files already listed when another place of the album fails', async () => {
    const { marker, tx } = setup({ unavailableFiles: [{ index: 0, code: 'unsafe_link' }] })

    await marker.mark(STORE, MESSAGE, 2, 'fetch_failed')

    expect((tx.message.updateMany.mock.calls[0] as [object] | undefined)?.[0]).toMatchObject({
      data: {
        metadata: {
          unavailableFiles: [
            { index: 0, code: 'unsafe_link' },
            { index: 2, code: 'fetch_failed' }
          ]
        }
      }
    })
  })

  it('writes nothing and announces nothing for a place that is already listed', async () => {
    const { marker, tx } = setup({ unavailableFiles: [{ index: 1, code: 'refused' }] })

    await marker.mark(STORE, MESSAGE, 1, 'fetch_failed')

    expect(tx.message.updateMany).not.toHaveBeenCalled()
    expect(publishMessageChanged).not.toHaveBeenCalled()
  })

  it('does nothing when the message is gone', async () => {
    const { marker, tx } = setup(null, false)

    await marker.mark(STORE, MESSAGE, 0, 'refused')

    expect(tx.message.updateMany).not.toHaveBeenCalled()
  })

  it('never throws: a failure is logged without its text', async () => {
    const { marker, prisma, logger } = setup(null)
    prisma.transaction.mockRejectedValue(new Error('secret'))

    await expect(marker.mark(STORE, MESSAGE, 0, 'refused')).resolves.toBeUndefined()

    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret')
  })

  it('keeps an entry it does not know when it adds another', async () => {
    const { marker, tx } = setup({
      unavailableFiles: [{ index: 0, code: 'from_a_newer_worker', extra: 1 }]
    })

    await marker.mark(STORE, MESSAGE, 1, 'refused')

    expect((tx.message.updateMany.mock.calls[0] as [object] | undefined)?.[0]).toMatchObject({
      data: {
        metadata: {
          unavailableFiles: [
            { index: 0, code: 'from_a_newer_worker', extra: 1 },
            { index: 1, code: 'refused' }
          ]
        }
      }
    })
  })
})
