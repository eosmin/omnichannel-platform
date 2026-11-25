import { UnrecoverableError } from 'bullmq'

import { JobContextError } from '@platform/core/database'
import { EmailDeliveryError, EmailDeliveryFallback, safeToken } from '@platform/core/email'
import { errorName } from '@platform/core/errors'
import type { MagicLinkIssuer } from '@platform/core/magic-link-issuer'

// What a job of mail throws when something other than the provider failed (the database, the lookup of an address): the name of what was
// thrown and nothing else. The message of such an error can hold the address the job was queued for (an ORM names the values of the row it
// could not write), and what a handler throws is kept by the queue as the failure of the job. It stays a plain error: the job is tried again.
export class MailJobFailedError extends Error {
  constructor(kind: unknown) {
    super(`the mail job failed: ${safeToken(kind) ?? EmailDeliveryFallback.KIND}`)
    this.name = 'MailJobFailedError'
  }
}

// Issues the link of an address typed by whoever asked, and lets nothing but the name of a failure out of the job. An error that the
// processor made itself (fixed text, unrecoverable) passes as it is.
export async function issueMagicLinkSafely(
  issuer: Pick<MagicLinkIssuer, 'issue'>,
  email: string,
  correlationId: string | undefined
): Promise<void> {
  try {
    await issuer.issue(email, correlationId)
  } catch (error) {
    if (error instanceof UnrecoverableError) throw error
    throw new MailJobFailedError(errorName(error))
  }
}

// The whole of what a mail processor does, so that nothing it does not control reaches the failure the queue keeps for the job
// (`failedReason`, the stack, the log). What the processor made itself (fixed text, unrecoverable), what the provider refused (already
// reduced to a name and a code) and what is already named and the errors of the job context (fixed text) pass as they are; anything else (the database, a template that is not Zod, a
// lookup) becomes the name of what was thrown and nothing more, because its message can hold the address the job was queued for.
export async function onlyTheNameOfAFailure<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (
      error instanceof UnrecoverableError ||
      error instanceof EmailDeliveryError ||
      error instanceof MailJobFailedError ||
      // Fixed text that names no job data, and `BaseProcessor` reads its type (a mismatch ends the job, a retry cannot help)
      error instanceof JobContextError
    ) {
      throw error
    }
    throw new MailJobFailedError(errorName(error))
  }
}
