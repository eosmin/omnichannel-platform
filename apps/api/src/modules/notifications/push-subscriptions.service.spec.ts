import type { PrismaService, PrismaTransaction } from '@platform/core/database'
import { PushLimits } from '@platform/core/notifications'

import { PushSubscriptionsService } from './push-subscriptions.service'

const USER = 'user-1'
const BODY = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', p256dh: 'p', auth: 'a' }

// Two clients that say which one a statement went through: the transaction that `transaction()` hands out, and `client`, which
// is what a statement outside of it would use. Both writes of a registration must go through the first.
function build(trimFails = false) {
  const through: string[] = []
  const table = (name: string) => ({
    upsert: jest.fn((_args: { update: { refusedCount: number; refusedNotificationId: null } }) => {
      through.push(`${name}:save`)
      return Promise.resolve({})
    }),
    findMany: jest.fn(() => {
      through.push(`${name}:list`)
      if (trimFails) return Promise.reject(new Error('db down'))
      return Promise.resolve(Array.from({ length: 2 }, (_, index) => ({ id: `old-${index}` })))
    }),
    deleteMany: jest.fn(() => {
      through.push(`${name}:trim`)
      return Promise.resolve({ count: 2 })
    })
  })
  const tx = {
    pushSubscription: table('tx'),
    $executeRaw: jest.fn(() => Promise.resolve(0)),
    $queryRaw: jest.fn(() => {
      through.push('tx:lock')
      return Promise.resolve([{ locked: 1 }])
    })
  }
  const outside = { pushSubscription: table('outside') }
  let committed = false
  const prisma = {
    client: outside,
    transaction: async (work: (db: PrismaTransaction) => Promise<void>) => {
      await work(tx as unknown as PrismaTransaction)
      committed = true
    }
  }
  return {
    service: new PushSubscriptionsService(prisma as unknown as PrismaService),
    through,
    tx,
    committed: () => committed
  }
}

describe('PushSubscriptionsService.register', () => {
  it('saves the browser and trims the old ones in the same transaction', async () => {
    const { service, through, committed } = build()

    await service.register(USER, BODY)

    // The lock of the person comes first: a second registration at once waits for the commit of this one and trims with its row in view
    expect(through).toEqual(['tx:lock', 'tx:save', 'tx:list', 'tx:trim'])
    expect(committed()).toBe(true)
  })

  it('does not commit when the trim fails, so the new browser is not kept beside the old ones', async () => {
    const { service, committed } = build(true)

    await expect(service.register(USER, BODY)).rejects.toThrow('db down')

    expect(committed()).toBe(false)
  })

  it('starts the refusal count of a browser that registers again', async () => {
    const { service, tx } = build()

    await service.register(USER, BODY)

    expect(tx.pushSubscription.upsert.mock.calls[0]?.[0].update.refusedCount).toBe(0)
    expect(tx.pushSubscription.upsert.mock.calls[0]?.[0].update.refusedNotificationId).toBeNull()
  })

  it('keeps only the newest browsers of the person', async () => {
    const { service, tx } = build()

    await service.register(USER, BODY)

    expect(tx.pushSubscription.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: PushLimits.MAX_SUBSCRIPTIONS_PER_USER,
        where: { userId: USER }
      })
    )
  })
})
