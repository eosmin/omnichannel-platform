import { CredentialCipher, parseEncryptionKey } from '@platform/core/crypto'
import { sealedMailAad } from '@platform/core/email'
import { EmailTemplates, type SendEmailJob } from '@platform/core/queues'

// The cipher the app under test seals the mails of a data request with (the key of the environment of the suite, as `CryptoPlatformModule` builds it)
export function testMailCipher(): CredentialCipher {
  // eslint-disable-next-line no-restricted-syntax -- the key the suite itself loaded for the app under test (tests/helpers/env.ts), read raw because this helper builds no app
  return new CredentialCipher(parseEncryptionKey(process.env['CREDENTIALS_ENCRYPTION_KEY'] ?? ''))
}

// The templates whose job holds a secret of a data request: they must reach the queue sealed (the spec of this helper fails when a `dsr-*`
// template is added to `EmailTemplates` and not here)
export const SEALED_TEMPLATES: ReadonlySet<string> = new Set([
  EmailTemplates.DSR_VERIFICATION,
  EmailTemplates.DSR_RESULT
])

// A producer catches the errors of its queue on purpose (a sweep counts it as failed, a review rolls back), so a throw alone can be swallowed
// and the suite would pass with the mail missing. Each job queued in the clear is also written here, and the suite fails after the test
const clearJobs: string[] = []

export function takeClearJobs(): string[] {
  return clearJobs.splice(0)
}

afterEach(() => {
  const found = takeClearJobs()
  if (found.length > 0) {
    throw new Error(`a mail of a data request was queued in the clear: ${found.join(', ')}`)
  }
})

// What a mail queue stand-in captured, as the mail it will send: a sealed job is opened. A job of a data request that arrives in the clear
// (a producer that stopped sealing) is recorded (the suite fails after the test) and THROWS; the jobs of the other templates are returned as
// they are. A job that looks sealed and does not open throws too. The suites use ids that are not UUIDs (`req-...`), which the worker's
// `sendEmailJobSchema` would refuse, so this opens the text with the real key and AAD and does not run that schema
export function mailOf(data: unknown): SendEmailJob {
  if (isSealedMail(data)) {
    const job = data as SealedShape
    const text = testMailCipher().openTextRotating(
      Buffer.from(job.sealed, 'base64'),
      sealedMailAad(job.template, job.dsrNotice?.requestId)
    ).text
    return {
      ...(JSON.parse(text) as SendEmailJob),
      ...(job.dsrNotice === undefined ? {} : { dsrNotice: job.dsrNotice }),
      ...(job.correlationId === undefined ? {} : { correlationId: job.correlationId })
    }
  }
  const template =
    typeof data === 'object' && data !== null
      ? (data as { template?: unknown }).template
      : undefined
  if (typeof template === 'string' && SEALED_TEMPLATES.has(template)) {
    clearJobs.push(template)
    throw new Error(`the mail of a data request (${template}) was queued in the clear`)
  }
  return data as SendEmailJob
}

interface SealedShape {
  template: string
  sealed: string
  dsrNotice?: { requestId: string; storeId: string }
  correlationId?: string
}

// The shape of what `sealMailJob` queues (ids are not checked as UUIDs here, see `mailOf`)
export function isSealedMail(data: unknown): boolean {
  if (typeof data !== 'object' || data === null) return false
  const job = data as { template?: unknown; sealed?: unknown }
  return typeof job.template === 'string' && typeof job.sealed === 'string' && job.sealed.length > 0
}
