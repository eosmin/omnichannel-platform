import { JobNames, submitFiscalDocumentJobId } from '@platform/core/queues'

import { FiscalSubmissionQueue } from './fiscal-submission.queue'

describe('FiscalSubmissionQueue', () => {
  const ORG = '8d88e80f-cecb-408a-bd99-9da2db20a7da'
  const DOCUMENT = '2d307c85-af40-4e6f-9c63-2c3d4e5f6071'
  const make = (earlier: { isFailed: () => Promise<boolean>; remove: jest.Mock } | undefined) => {
    const add = jest.fn().mockResolvedValue(undefined)
    const getJob = jest.fn().mockResolvedValue(earlier)
    // With no transaction open the step runs at once, as PrismaService.afterCommitStep does
    const prisma = {
      client: {},
      afterCommitStep: (_db: unknown, step: () => Promise<unknown>) => step()
    }
    return {
      add,
      getJob,
      producer: new FiscalSubmissionQueue({ add, getJob } as never, prisma as never)
    }
  }

  it('queues the ids only, under the id of the document and its submission', async () => {
    const { add, producer } = make(undefined)
    await producer.enqueue(ORG, DOCUMENT, 2)
    expect(add).toHaveBeenCalledWith(
      JobNames.SUBMIT_FISCAL_DOCUMENT,
      { organizationId: ORG, documentId: DOCUMENT },
      expect.objectContaining({ jobId: submitFiscalDocumentJobId(DOCUMENT, 2) })
    )
  })

  it('removes a failed job of the same id first: a retry of a person must not be dropped in silence', async () => {
    const remove = jest.fn().mockResolvedValue(undefined)
    const { add, producer } = make({ isFailed: () => Promise.resolve(true), remove })
    await producer.enqueue(ORG, DOCUMENT, 1)
    expect(remove).toHaveBeenCalledTimes(1)
    expect(add).toHaveBeenCalledTimes(1)
  })

  it('leaves a job that is waiting or running as it is: a duplicate request is one job', async () => {
    const remove = jest.fn()
    const { add, producer } = make({ isFailed: () => Promise.resolve(false), remove })
    await producer.enqueue(ORG, DOCUMENT, 1)
    expect(remove).not.toHaveBeenCalled()
    expect(add).toHaveBeenCalledTimes(1)
  })
})
