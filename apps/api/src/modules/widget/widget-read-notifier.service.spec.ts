import type { PinoLogger } from 'nestjs-pino'

import type { PrismaService } from '@platform/core/database'

import type { WidgetDelivery } from './widget-delivery.service'
import { WidgetReadNotifier } from './widget-read-notifier.service'

const STORE_ID = 'store-a'
const UP_TO = new Date('2026-11-20T10:00:00Z')

function build(over: { enabled?: boolean; rows?: () => Promise<unknown> }) {
  const findSettings = jest.fn(() =>
    Promise.resolve({ preferences: { sendReadReceipts: over.enabled ?? true } })
  )
  const queryRaw = jest.fn(
    over.rows ??
      (() =>
        Promise.resolve([
          { id: 'm1', connection_id: 'conn-1', channel_identity: 'visitor-1' },
          { id: 'm2', connection_id: 'conn-1', channel_identity: 'visitor-2' }
        ]))
  )
  const readToVisitor = jest.fn()
  const warn = jest.fn()
  const afterCommit = jest.fn((_db: unknown, hook: () => void) => hook())
  const prisma = {
    client: { storeSettings: { findUnique: findSettings }, $queryRaw: queryRaw },
    afterCommit
  } as unknown as PrismaService // the two reads the batch makes
  const delivery = { readToVisitor } as unknown as WidgetDelivery
  const logger = { setContext: jest.fn(), warn } as unknown as PinoLogger
  return {
    notifier: new WidgetReadNotifier(prisma, delivery, logger),
    findSettings,
    queryRaw,
    readToVisitor,
    warn
  }
}

describe('WidgetReadNotifier.notifyMany', () => {
  it('reads once for the whole batch and emits once per conversation with a target', async () => {
    const { notifier, findSettings, queryRaw, readToVisitor } = build({})

    await notifier.notifyMany(STORE_ID, ['c1', 'c2', 'c3'], UP_TO)

    expect(findSettings).toHaveBeenCalledTimes(1)
    expect(queryRaw).toHaveBeenCalledTimes(1)
    expect(readToVisitor).toHaveBeenCalledTimes(2)
    expect(readToVisitor).toHaveBeenCalledWith('conn-1', 'visitor-1', 'm1')
  })

  it('does not look for messages when the store switched receipts off', async () => {
    const { notifier, queryRaw, readToVisitor } = build({ enabled: false })

    await notifier.notifyMany(STORE_ID, ['c1'], UP_TO)

    expect(queryRaw).not.toHaveBeenCalled()
    expect(readToVisitor).not.toHaveBeenCalled()
  })

  it('does nothing for an empty batch', async () => {
    const { notifier, findSettings } = build({})

    await notifier.notifyMany(STORE_ID, [], UP_TO)

    expect(findSettings).not.toHaveBeenCalled()
  })

  it('logs the size of the batch when the lookup fails, and does not reject', async () => {
    const { notifier, warn, readToVisitor } = build({
      rows: () => Promise.reject(new TypeError('boom'))
    })

    await expect(notifier.notifyMany(STORE_ID, ['c1', 'c2'], UP_TO)).resolves.toBeUndefined()

    expect(readToVisitor).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(
      { conversations: 2, errorName: 'TypeError' },
      'the widget read receipts of a batch could not be sent'
    )
  })
})
