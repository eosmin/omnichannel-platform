import { DEFAULT_LOCALE, Locales } from '@platform/core/i18n'

import { EmailTemplates } from '../queues/email-templates'
import { dsrResultMailJobId, JobNames } from '../queues/queue-names'

import {
  ComplianceConfig,
  DsrResultOutcomes,
  dsrNoticeStatusOf,
  DsrNoticeStatuses
} from './compliance-constants'
import { dsrNoticeJob, dsrNoticeLocaleOf } from './dsr-notice'

const REQUEST = '0b9d6d88-9a1d-4c4a-9a31-5a2f2d3a6f10'
const STORE = '1c0e7c20-6a0b-4f6e-8f3a-3b6f9a5a2f11'

describe('the closing mail of a data request', () => {
  const job = dsrNoticeJob({
    requestId: REQUEST,
    storeId: STORE,
    to: 'person@example.com',
    locale: Locales.ES,
    outcome: DsrResultOutcomes.COMPLETED,
    requestType: 'erasure',
    retainedOrders: 2
  })

  it('carries the ids the mail processor confirms it by, and the address only as its recipient', () => {
    expect(job.name).toBe(JobNames.SEND_EMAIL)
    expect(job.data.dsrNotice).toEqual({ requestId: REQUEST, storeId: STORE })
    expect(job.data.template).toBe(EmailTemplates.DSR_RESULT)
    expect(job.data.tags).toEqual({ storeId: STORE, template: EmailTemplates.DSR_RESULT })
    expect(JSON.stringify({ ...job.data, to: null })).not.toContain('person@example.com')
    expect(job.data.data).toEqual({
      outcome: 'completed',
      requestType: 'erasure',
      retainedOrders: 2
    })
  })

  it('is one job for the request, and is dropped whatever happens to it, because it holds the address', () => {
    expect(job.opts).toEqual({
      jobId: dsrResultMailJobId(REQUEST),
      removeOnComplete: true,
      removeOnFail: true,
      attempts: ComplianceConfig.DSR_NOTICE_MAIL_ATTEMPTS,
      backoff: { type: 'exponential', delay: ComplianceConfig.DSR_NOTICE_MAIL_BACKOFF_MS }
    })
  })

  it('is tried again for ten minutes at least, and for less than the lease that keeps the sweep from queueing it twice', () => {
    let waited = 0
    for (let failure = 1; failure < ComplianceConfig.DSR_NOTICE_MAIL_ATTEMPTS; failure += 1)
      waited += ComplianceConfig.DSR_NOTICE_MAIL_BACKOFF_MS * 2 ** (failure - 1)
    expect(waited).toBeGreaterThanOrEqual(10 * 60_000)
    expect(waited).toBeLessThan(ComplianceConfig.DSR_NOTICE_LEASE_MS)
  })

  it('leaves the count of retained orders out of a notice that has none', () => {
    const rejected = dsrNoticeJob({
      requestId: REQUEST,
      storeId: STORE,
      to: 'person@example.com',
      locale: Locales.EN,
      outcome: DsrResultOutcomes.REJECTED,
      requestType: 'access'
    })

    expect(rejected.data.data).toEqual({ outcome: 'rejected', requestType: 'access' })
  })
})

describe('where the closing notice of a request stands', () => {
  const sealed = new Uint8Array([1, 2, 3])
  const none = { noticeSentAt: null, noticeFailedAt: null, notifyToEncrypted: null }

  it.each([
    ['sent', { ...none, noticeSentAt: new Date() }, DsrNoticeStatuses.SENT],
    [
      'sent even if an earlier attempt failed',
      { ...none, noticeSentAt: new Date(), noticeFailedAt: new Date() },
      DsrNoticeStatuses.SENT
    ],
    [
      'pending: the address is sealed and nothing confirmed it',
      { ...none, notifyToEncrypted: sealed },
      DsrNoticeStatuses.PENDING
    ],
    [
      'pending after a failed attempt that will be retried',
      { ...none, notifyToEncrypted: sealed, noticeFailedAt: new Date() },
      DsrNoticeStatuses.PENDING
    ],
    [
      'failed: the attempts are spent and no address is left',
      { ...none, noticeFailedAt: new Date() },
      DsrNoticeStatuses.FAILED
    ],
    ['none: there was never an address to tell', none, DsrNoticeStatuses.NONE]
  ])('%s', (_name, row, expected) => {
    expect(dsrNoticeStatusOf(row)).toBe(expected)
  })
})

describe('the language of the closing mail', () => {
  it('is the one the person asked in, even when the store writes in another', () => {
    expect(dsrNoticeLocaleOf(Locales.EN, Locales.ES)).toBe(Locales.EN)
    expect(dsrNoticeLocaleOf(Locales.ES, Locales.EN)).toBe(Locales.ES)
  })

  it('is the language of the store for a request that kept none', () => {
    expect(dsrNoticeLocaleOf(null, Locales.EN)).toBe(Locales.EN)
    expect(dsrNoticeLocaleOf(undefined, Locales.EN)).toBe(Locales.EN)
  })

  it('skips a code that is not a supported language, and ends on the default of the platform', () => {
    expect(dsrNoticeLocaleOf('xx', Locales.EN)).toBe(Locales.EN)
    expect(dsrNoticeLocaleOf(null, 'xx')).toBe(DEFAULT_LOCALE)
    expect(dsrNoticeLocaleOf(null, null)).toBe(DEFAULT_LOCALE)
  })
})
