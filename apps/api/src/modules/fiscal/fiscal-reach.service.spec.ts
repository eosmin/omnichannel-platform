import type { PrismaService } from '@platform/core/database'

import { FiscalReachService } from './fiscal-reach.service'

function serviceWith(count: jest.Mock): FiscalReachService {
  const prisma = { client: { fiscalDocument: { count }, membership: { findMany: jest.fn() } } }
  return new FiscalReachService(prisma as unknown as PrismaService)
}

describe('FiscalReachService.assertDocuments (HC-128)', () => {
  it('asks for the documents of the organization in the stores of the reach, each id once', async () => {
    const count = jest.fn().mockResolvedValue(2)
    await serviceWith(count).assertDocuments('org', ['a', 'b', 'a'], ['s1', 's2'])
    expect(count).toHaveBeenCalledWith({
      where: { id: { in: ['a', 'b'] }, organizationId: 'org', storeId: { in: ['s1', 's2'] } }
    })
  })

  it('answers a not found when one of the documents is out of reach', async () => {
    const count = jest.fn().mockResolvedValue(1)
    await expect(serviceWith(count).assertDocuments('org', ['a', 'b'], ['s1'])).rejects.toThrow()
  })

  it('answers a not found with no query when the person reaches no store', async () => {
    const count = jest.fn()
    await expect(serviceWith(count).assertDocuments('org', ['a'], [])).rejects.toThrow()
    expect(count).not.toHaveBeenCalled()
  })

  it('has nothing to check for no document', async () => {
    const count = jest.fn()
    await serviceWith(count).assertDocuments('org', [], ['s1'])
    expect(count).not.toHaveBeenCalled()
  })
})
