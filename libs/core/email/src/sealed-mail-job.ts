import { z } from 'zod'

import type { CredentialCipher } from '@platform/core/crypto'
import { type SendEmailJob, sendEmailJobSchema } from '@platform/core/queues'

// The mail of a data request in the queue (Step 7.2-H2b, mail queue seal). The job of such a mail carries the address and, for the mail that
// hands a file over or confirms an address, a link that holds the only copy of a token. Redis keeps a waiting or retried job in the clear
// unless the producer seals it, so the producer puts the whole mail inside one sealed text (the key of the credentials) and the job keeps
// only what is not a secret: the template, and the ids the processor needs to confirm the notice on its request. The processor opens it.
// Nothing here logs, and the errors have fixed text: they never quote what was sealed.
export const SealedMailJob = {
  // The seal is bound to the template and the request it belongs to (AES-GCM associated data): a sealed mail copied into the job of another
  // template, or of another request, does not open
  AAD_PREFIX: 'mail-job',
  // A sealed mail past this size is not one we made
  SEALED_MAX_LENGTH: 100_000
} as const

export const SealedMailFailure = {
  // The seal did not open (wrong key, altered job, another template or request)
  UNREADABLE: 'unreadable',
  // It opened but is not a mail the template queue accepts
  MALFORMED: 'malformed'
} as const
export type SealedMailFailure = (typeof SealedMailFailure)[keyof typeof SealedMailFailure]

export class SealedMailError extends Error {
  constructor(readonly failure: SealedMailFailure) {
    super(`the sealed mail job is ${failure}`)
    this.name = 'SealedMailError'
  }
}

export const sealedMailJobSchema = z
  .object({
    template: z.string().min(1).max(64),
    sealed: z.string().min(1).max(SealedMailJob.SEALED_MAX_LENGTH),
    dsrNotice: z.object({ requestId: z.uuid(), storeId: z.uuid() }).optional(),
    correlationId: z.string().optional()
  })
  .strict()

export type SealedMailJobData = z.output<typeof sealedMailJobSchema>

export function sealedMailAad(template: string, requestId: string | undefined): string {
  return `${SealedMailJob.AAD_PREFIX}:${template}:${requestId ?? ''}`
}

export function sealMailJob(
  cipher: Pick<CredentialCipher, 'sealText'>,
  mail: Omit<SendEmailJob, 'dsrNotice' | 'correlationId'> &
    Pick<SendEmailJob, 'dsrNotice' | 'correlationId'>
): SealedMailJobData {
  const { dsrNotice, correlationId, ...content } = mail
  const sealed = cipher.sealText(
    JSON.stringify(content),
    sealedMailAad(mail.template, dsrNotice?.requestId)
  )
  return {
    template: mail.template,
    sealed: sealed.toString('base64'),
    ...(dsrNotice === undefined ? {} : { dsrNotice }),
    ...(correlationId === undefined ? {} : { correlationId })
  }
}

// What comes out of Redis is a boundary: it is opened with the current key (or the previous one while a rotation is on) and checked again
export function openMailJob(
  cipher: Pick<CredentialCipher, 'openTextRotating'>,
  job: SealedMailJobData
): SendEmailJob {
  let text: string
  try {
    text = cipher.openTextRotating(
      Buffer.from(job.sealed, 'base64'),
      sealedMailAad(job.template, job.dsrNotice?.requestId)
    ).text
  } catch {
    throw new SealedMailError(SealedMailFailure.UNREADABLE)
  }
  let content: unknown
  try {
    content = JSON.parse(text)
  } catch {
    throw new SealedMailError(SealedMailFailure.MALFORMED)
  }
  const parsed = sendEmailJobSchema.safeParse({
    ...(typeof content === 'object' && content !== null ? content : {}),
    ...(job.dsrNotice === undefined ? {} : { dsrNotice: job.dsrNotice }),
    ...(job.correlationId === undefined ? {} : { correlationId: job.correlationId })
  })
  if (!parsed.success || parsed.data.template !== job.template) {
    throw new SealedMailError(SealedMailFailure.MALFORMED)
  }
  return parsed.data
}
