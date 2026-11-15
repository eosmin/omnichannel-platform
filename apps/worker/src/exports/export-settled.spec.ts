import type { PrismaService } from '@platform/core/database'
import type { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'

import { publishExportSettled } from './export-settled'

const ROW = {
  id: '3c1e5a9d-7b24-4f6a-8d02-9a1b4c7e2f10',
  storeId: '5d2f6b0e-8c35-4a7b-9e13-0b2c5d8f3a21',
  type: 'analytics'
}

function fakes() {
  const publish = jest.fn()
  const transaction = jest.fn((work: (tx: unknown) => Promise<void>) => work({}))
  return {
    publish,
    transaction,
    prisma: { transaction } as unknown as PrismaService,
    events: { publish } as unknown as DomainEvents
  }
}

describe('publishExportSettled', () => {
  it('tells the api that the export of a person settled, with the ids and the kind only', async () => {
    const { prisma, events, publish } = fakes()
    const requestedBy = '7e3a7c1f-9d46-4b8c-8f24-1c3d6e9a4b32'

    await publishExportSettled(prisma, events, Events.EXPORT_READY, { ...ROW, requestedBy })

    expect(publish).toHaveBeenCalledWith({}, Events.EXPORT_READY, {
      storeId: ROW.storeId,
      exportId: ROW.id,
      requestedBy,
      exportType: ROW.type
    })
  })

  it('says nothing of the export of a plugin: the event names a person and a plugin polls its export', async () => {
    const { prisma, events, publish, transaction } = fakes()

    await publishExportSettled(prisma, events, Events.EXPORT_FAILED, {
      ...ROW,
      requestedBy: 'plugin:0b8e7a52-6d1f-4a63-8c4e-2f9d3b7a1e55'
    })

    expect(transaction).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
  })
})
