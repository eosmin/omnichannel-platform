import { sealMailJob } from '@platform/core/email'
import { Locales } from '@platform/core/i18n'
import { EmailTemplates, type SendEmailJob } from '@platform/core/queues'

import { isSealedMail, mailOf, testMailCipher } from '../helpers/mail-seal'

const clear: SendEmailJob = {
  template: EmailTemplates.DSR_RESULT,
  to: 'ana@example.com',
  locale: Locales.EN,
  data: { downloadUrl: 'https://app.example.com/x#token=abc' },
  tags: { template: EmailTemplates.DSR_RESULT }
}

describe('mail-seal test helper', () => {
  beforeAll(() => {
    // eslint-disable-next-line no-restricted-syntax -- a fixed key of this spec, as tests/helpers/env.ts sets one for the suites
    process.env['CREDENTIALS_ENCRYPTION_KEY'] = 'f'.repeat(64)
  })

  it('opens a sealed job', () => {
    const sealed = sealMailJob(testMailCipher(), clear)
    expect(isSealedMail(sealed)).toBe(true)
    expect(mailOf(sealed)).toEqual(clear)
  })

  it.each([EmailTemplates.DSR_RESULT, EmailTemplates.DSR_VERIFICATION])(
    'fails on a %s job queued in the clear, so a producer that stops sealing is caught',
    template => {
      expect(() => mailOf({ ...clear, template })).toThrow(/queued in the clear/)
    }
  )

  it('lets the job of another template through as it is', () => {
    const other = { ...clear, template: EmailTemplates.MAGIC_LINK }
    expect(mailOf(other)).toBe(other)
  })
})
