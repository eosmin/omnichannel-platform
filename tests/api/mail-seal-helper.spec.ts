import { CredentialCipher, parseEncryptionKey } from '@platform/core/crypto'
import { sealMailJob } from '@platform/core/email'
import { Locales } from '@platform/core/i18n'
import { EmailTemplates, type SendEmailJob } from '@platform/core/queues'

import {
  isSealedMail,
  mailOf,
  SEALED_TEMPLATES,
  takeClearJobs,
  testMailCipher
} from '../helpers/mail-seal'

const clear: SendEmailJob = {
  template: EmailTemplates.DSR_RESULT,
  to: 'ana@example.com',
  locale: Locales.EN,
  data: { downloadUrl: 'https://app.example.com/x#token=abc' },
  tags: { template: EmailTemplates.DSR_RESULT }
}

describe('mail-seal test helper', () => {
  it('opens a sealed job', () => {
    const sealed = sealMailJob(testMailCipher(), clear)
    expect(isSealedMail(sealed)).toBe(true)
    expect(mailOf(sealed)).toEqual(clear)
  })

  it.each([EmailTemplates.DSR_RESULT, EmailTemplates.DSR_VERIFICATION])(
    'fails on a %s job queued in the clear, and records it for the suite that queued it',
    template => {
      expect(() => mailOf({ ...clear, template })).toThrow(/queued in the clear/)
      expect(takeClearJobs()).toEqual([template])
    }
  )

  it('covers every data request template of EmailTemplates', () => {
    const dsr = Object.values<string>(EmailTemplates).filter(name => name.startsWith('dsr-'))
    expect(dsr.length).toBeGreaterThan(0)
    for (const name of dsr) expect(SEALED_TEMPLATES.has(name)).toBe(true)
  })

  it('lets the job of another template through as it is', () => {
    const other = { ...clear, template: EmailTemplates.MAGIC_LINK }
    expect(mailOf(other)).toBe(other)
  })

  it.each([null, undefined, 'text', 42])('does not fail on a payload that is %p', payload => {
    expect(mailOf(payload)).toBe(payload)
    expect(takeClearJobs()).toEqual([])
  })

  it('throws on a sealed job that does not open, and does not pass it through', () => {
    const other = new CredentialCipher(parseEncryptionKey('9'.repeat(64)))
    expect(() => mailOf(sealMailJob(other, clear))).toThrow()
    expect(takeClearJobs()).toEqual([])
  })
})
