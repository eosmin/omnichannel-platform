import { CredentialCipher, parseEncryptionKey } from '@platform/core/crypto'
import { openMailJob, sealedMailJobSchema } from '@platform/core/email'
import { EmailTemplates, type SendEmailJob } from '@platform/core/queues'

// The cipher the app under test seals the mails of a data request with (the key of the environment of the suite, as `CryptoPlatformModule` builds it)
export function testMailCipher(): CredentialCipher {
  // eslint-disable-next-line no-restricted-syntax -- the key the suite itself loaded for the app under test (tests/helpers/env.ts), read raw because this helper builds no app
  return new CredentialCipher(parseEncryptionKey(process.env['CREDENTIALS_ENCRYPTION_KEY'] ?? ''))
}

// The templates whose job holds a secret of a data request: they must reach the queue sealed
const SEALED_TEMPLATES: ReadonlySet<string> = new Set([
  EmailTemplates.DSR_VERIFICATION,
  EmailTemplates.DSR_RESULT
])

// What a mail queue stand-in captured, as the mail it will send: a sealed job is opened. A job of a data request that arrives in the clear
// (a producer that stopped sealing) THROWS, so the suite that queued it fails; the jobs of the other templates are returned as they are
export function mailOf(data: unknown): SendEmailJob {
  const sealed = sealedMailJobSchema.safeParse(data)
  if (sealed.success) return openMailJob(testMailCipher(), sealed.data)
  const template = (data as { template?: unknown } | null)?.template
  if (typeof template === 'string' && SEALED_TEMPLATES.has(template)) {
    throw new Error(`the mail of a data request (${template}) was queued in the clear`)
  }
  return data as SendEmailJob
}

export function isSealedMail(data: unknown): boolean {
  return sealedMailJobSchema.safeParse(data).success
}
