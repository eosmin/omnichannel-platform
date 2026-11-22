import { NotificationTypes } from '@platform/core/notifications'

import { NotificationsService } from './notifications.service'

const STORE = 'store-1'
const USER = 'user-1'
const RESOURCE = 'conversation-1'

// A handler of an event with RLS on runs in a transaction of its own that commits AFTER the handler returns, so a row written by
// one handler is invisible to the next until then. The fake database below models only that: a row is seen after its
// transaction commits, and an advisory transaction lock is held until the commit of whoever took it.
function build() {
  const committed: { userId: string }[] = []
  let holder: Promise<void> | undefined
  let lockCalls = 0

  const transaction = async <T>(work: (client: unknown) => Promise<T>): Promise<T> => {
    const pendingRows: { userId: string }[] = []
    let release: () => void = () => undefined
    const done = new Promise<void>(resolve => {
      release = resolve
    })
    const client = {
      $queryRaw: async () => {
        lockCalls += 1
        const before = holder
        holder = done
        if (before !== undefined) await before
        return [{ locked: 1 }]
      },
      notification: {
        findMany: () => Promise.resolve(committed.map(row => ({ userId: row.userId }))),
        create: (args: { data: { userId: string } }) => {
          pendingRows.push({ userId: args.data.userId })
          return Promise.resolve({
            id: 'n',
            messageKey: 'k',
            actionPath: null,
            createdAt: new Date()
          })
        }
      }
    }
    try {
      return await work(client)
    } finally {
      committed.push(...pendingRows)
      release()
    }
  }

  const services = (client: unknown) => {
    const prisma = {
      client,
      currentTenantContext: () => ({}),
      afterCommitStep: async (_client: unknown, step: () => Promise<void>) => step()
    }
    const preferences = {
      loadRecipients: () => Promise.resolve(undefined),
      resolve: () => Promise.resolve({ inApp: false, push: false, sound: false, email: false }),
      settingsOf: () => Promise.resolve({ digestFrequency: 'off' })
    }
    const realtime = { toStoreUser: () => undefined }
    const queue = { add: () => Promise.resolve(undefined) }
    return new NotificationsService(
      prisma as never,
      realtime as never,
      preferences as never,
      queue as never
    )
  }

  const burst = async (size: number) =>
    Promise.all(
      Array.from({ length: size }, () =>
        transaction(async client =>
          services(client).sendToUsersOnce([USER], {
            storeId: STORE,
            type: NotificationTypes.MESSAGE_RECEIVED,
            resourceType: 'conversation',
            resourceId: RESOURCE
          })
        )
      )
    )

  return { committed, burst, lockCalls: () => lockCalls }
}

describe('NotificationsService.sendToUsersOnce under a transaction per event', () => {
  it('writes one line for a burst whose handlers commit after they return', async () => {
    const { committed, burst } = build()

    await burst(10)

    expect(committed).toHaveLength(1)
  })

  it('takes the lock of the transaction before it looks for an unread line', async () => {
    const { burst, lockCalls } = build()

    await burst(3)

    expect(lockCalls()).toBe(3)
  })
})
