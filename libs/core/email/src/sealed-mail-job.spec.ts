import { CredentialCipher, parseEncryptionKey } from '@platform/core/crypto'
import { Locales } from '@platform/core/i18n'
import { EmailTemplates, type SendEmailJob } from '@platform/core/queues'

import {
  openMailJob,
  SealedMailError,
  SealedMailFailure,
  sealedMailJobSchema,
  sealMailJob
} from './sealed-mail-job'

const ID = '0b9d6d88-9a1d-4c4a-9a31-5a2f2d3a6f10'
const cipher = new CredentialCipher(parseEncryptionKey('a'.repeat(64)))
const mail: SendEmailJob = {
  template: EmailTemplates.DSR_VERIFICATION,
  to: 'ana@example.com',
  locale: Locales.EN,
  data: { url: 'https://app.example.com/dsr#token=raw-secret' },
  tags: { template: EmailTemplates.DSR_VERIFICATION },
  correlationId: 'corr'
}

describe('sealed mail job', () => {
  it('keeps no address, link or token in the job, only the template and the ids', () => {
    const sealed = sealMailJob(cipher, { ...mail, dsrNotice: { requestId: ID, storeId: ID } })

    expect(sealedMailJobSchema.safeParse(sealed).success).toBe(true)
    expect(JSON.stringify(sealed)).not.toMatch(/example\.com|raw-secret|ana/)
    expect(Object.keys(sealed).sort()).toEqual(['correlationId', 'dsrNotice', 'sealed', 'template'])
  })

  it('round-trips the mail', () => {
    const notice = { requestId: ID, storeId: ID }
    expect(openMailJob(cipher, sealMailJob(cipher, { ...mail, dsrNotice: notice }))).toEqual({
      ...mail,
      dsrNotice: notice
    })
  })

  it('opens what the previous key sealed while a rotation is on', () => {
    const before = new CredentialCipher(parseEncryptionKey('b'.repeat(64)))
    const rotated = new CredentialCipher(
      parseEncryptionKey('a'.repeat(64)),
      parseEncryptionKey('b'.repeat(64))
    )
    expect(openMailJob(rotated, sealMailJob(before, mail))).toEqual(mail)
  })

  it('fails closed on another key, an altered text and another template, with fixed text', () => {
    const sealed = sealMailJob(cipher, mail)
    const other = new CredentialCipher(parseEncryptionKey('c'.repeat(64)))
    const altered = Buffer.from(sealed.sealed, 'base64')
    altered[altered.length - 1] = (altered[altered.length - 1] ?? 0) ^ 1
    const attempts = [
      () => openMailJob(other, sealed),
      () => openMailJob(cipher, { ...sealed, sealed: altered.toString('base64') }),
      () => openMailJob(cipher, { ...sealed, template: EmailTemplates.DSR_RESULT })
    ]
    for (const attempt of attempts) {
      let thrown: unknown
      try {
        attempt()
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(SealedMailError)
      expect((thrown as SealedMailError).failure).toBe(SealedMailFailure.UNREADABLE)
      expect((thrown as Error).message).not.toMatch(/example\.com|raw-secret/)
    }
  })
})
