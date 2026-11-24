import { UnrecoverableError } from 'bullmq'

import { EmailDeliveryFallback, safeToken } from '@platform/core/email'
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
