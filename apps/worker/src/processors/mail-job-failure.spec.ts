import { UnrecoverableError } from 'bullmq'

import { EmailDeliveryFallback } from '@platform/core/email'

import { issueMagicLinkSafely, MailJobFailedError } from './mail-job-failure'

const ADDRESS = 'victim.person@example.com'

describe('issueMagicLinkSafely', () => {
  it('lets a link that was issued through', async () => {
    const issue = jest.fn().mockResolvedValue(undefined)

    await expect(issueMagicLinkSafely({ issue }, ADDRESS, 'c-1')).resolves.toBeUndefined()

    expect(issue).toHaveBeenCalledWith(ADDRESS, 'c-1')
  })

  it('throws the name of a database error and not its text, which names the row it could not write', async () => {
    const database = Object.assign(
      new Error(`Unique constraint failed on the fields: (\`subject\`) = (${ADDRESS})`),
      { code: 'P2002', meta: { target: ['subject'] }, name: 'PrismaClientKnownRequestError' }
    )

    const thrown: unknown = await issueMagicLinkSafely(
      { issue: () => Promise.reject(database) },
      ADDRESS,
      undefined
    ).then(
      () => null,
      (failure: unknown) => failure
    )

    expect(thrown).toBeInstanceOf(MailJobFailedError)
    const error = thrown as MailJobFailedError
    expect(error.message).toBe('the mail job failed: PrismaClientKnownRequestError')
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(ADDRESS)
    expect(error.stack ?? '').not.toContain(ADDRESS)
  })

  it('does not trust a name that is not a plain token', async () => {
    const odd = Object.assign(new Error('x'), { name: `Bad ${ADDRESS}` })

    const thrown = await issueMagicLinkSafely(
      { issue: () => Promise.reject(odd) },
      ADDRESS,
      undefined
    ).catch((failure: unknown) => failure)

    expect((thrown as Error).message).toBe(`the mail job failed: ${EmailDeliveryFallback.KIND}`)
  })

  it('lets an unrecoverable error that the processor made itself pass as it is', async () => {
    const own = new UnrecoverableError('fixed text')

    await expect(
      issueMagicLinkSafely({ issue: () => Promise.reject(own) }, ADDRESS, undefined)
    ).rejects.toBe(own)
  })
})
