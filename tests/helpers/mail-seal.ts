import { CredentialCipher, parseEncryptionKey } from '@platform/core/crypto'
import { openMailJob, sealedMailJobSchema } from '@platform/core/email'
import type { SendEmailJob } from '@platform/core/queues'

// The cipher the app under test seals the mails of a data request with (the key of the environment of the suite, as `CryptoPlatformModule` builds it)
export function testMailCipher(): CredentialCipher {
  // eslint-disable-next-line no-restricted-syntax -- the key the suite itself loaded for the app under test (tests/helpers/env.ts), read raw because this helper builds no app
  return new CredentialCipher(parseEncryptionKey(process.env['CREDENTIALS_ENCRYPTION_KEY'] ?? ''))
}

// What a mail queue stand-in captured, as the mail it will send: a sealed job is opened, a job in the clear is returned as it is. The
// suites assert on the mail, and `isSealedMail` on what Redis would have kept
export function mailOf(data: unknown): SendEmailJob {
  const sealed = sealedMailJobSchema.safeParse(data)
  return sealed.success ? openMailJob(testMailCipher(), sealed.data) : (data as SendEmailJob)
}

export function isSealedMail(data: unknown): boolean {
  return sealedMailJobSchema.safeParse(data).success
}
