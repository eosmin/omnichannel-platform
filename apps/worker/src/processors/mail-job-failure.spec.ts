import { UnrecoverableError } from 'bullmq'

import { JobContextGoneError, JobContextMismatchError } from '@platform/core/database'
import { EmailDeliveryError, EmailDeliveryFallback } from '@platform/core/email'

import { JobRejectedError } from './job-rejected.error'
import { issueMagicLinkSafely, MailJobFailedError, onlyTheNameOfAFailure } from './mail-job-failure'

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

describe('onlyTheNameOfAFailure', () => {
  it('returns what the work returns', async () => {
    await expect(onlyTheNameOfAFailure(() => Promise.resolve())).resolves.toBeUndefined()
  })

  it('turns an error of the database, which names the row, into the name of the error', async () => {
    const database = Object.assign(new Error(`Invalid value for (${ADDRESS}) in column email`), {
      name: 'PrismaClientValidationError'
    })

    const thrown: unknown = await onlyTheNameOfAFailure(() => Promise.reject(database)).catch(
      (failure: unknown) => failure
    )

    expect(thrown).toBeInstanceOf(MailJobFailedError)
    expect((thrown as Error).message).toBe('the mail job failed: PrismaClientValidationError')
    expect(JSON.stringify(thrown, Object.getOwnPropertyNames(thrown))).not.toContain(ADDRESS)
  })

  it('does not trust a name that is not a plain token', async () => {
    const odd = Object.assign(new Error('x'), { name: `Bad ${ADDRESS}` })

    const thrown: unknown = await onlyTheNameOfAFailure(() => Promise.reject(odd)).catch(
      (failure: unknown) => failure
    )

    expect((thrown as Error).message).toBe(`the mail job failed: ${EmailDeliveryFallback.KIND}`)
  })

  it.each([
    ['an unrecoverable error', new UnrecoverableError('fixed text')],
    ['a rejected payload', new JobRejectedError('fixed text')],
    ['a refusal of the provider', new EmailDeliveryError('validation_error', 422)],
    ['a store that is not the one of its row', new JobContextMismatchError('fixed text')],
    ['a store that was deleted', new JobContextGoneError('fixed text')],
    ['a failure that is already named', new MailJobFailedError('PrismaClientKnownRequestError')]
  ])('lets %s pass as it is', async (_label, own) => {
    await expect(onlyTheNameOfAFailure(() => Promise.reject(own))).rejects.toBe(own)
  })
})
