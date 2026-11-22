import { Locales } from '@platform/core/i18n'

import { EmailTemplates } from './email-templates'
import {
  checkRemittancesJobSchema,
  deliverInvitationEmailJobSchema,
  fetchCustomerProfileJobSchema,
  queueEmailDigestJobSchema,
  requestMagicLinkJobSchema,
  sendEmailDigestJobSchema,
  sendEmailJobSchema,
  sendWebPushJobSchema
} from './job-schemas'

const ID = '0b9d6d88-9a1d-4c4a-9a31-5a2f2d3a6f10'
const longId = 'a'.repeat(129)

const email = {
  template: EmailTemplates.ORDER_MESSAGE,
  to: 'a@example.com',
  locale: Locales.ES,
  data: { text: 'hi' },
  tags: { template: EmailTemplates.ORDER_MESSAGE }
}

describe('the schemas of the email jobs', () => {
  it('accepts the general email with and without its optional parts', () => {
    expect(sendEmailJobSchema.safeParse(email).success).toBe(true)
    expect(
      sendEmailJobSchema.safeParse({
        ...email,
        to: ['a@example.com', 'b@example.com'],
        attachments: [{ filename: 'r.csv', contentBase64: 'AAAA', contentType: 'text/csv' }],
        headers: { 'List-Unsubscribe': '<https://example.com/u>' },
        tags: { storeId: ID, template: EmailTemplates.SCHEDULED_REPORT },
        correlationId: ID
      }).success
    ).toBe(true)
  })

  it.each([
    ['a template that does not exist', { template: 'nope' }],
    ['a locale that is not supported', { locale: 'xx' }],
    ['no recipient', { to: [] }],
    ['a recipient that is a number', { to: 7 }],
    ['data that is a list', { data: [] }],
    [
      'a store tag that is not an id',
      { tags: { storeId: 'x', template: EmailTemplates.INVITATION } }
    ],
    [
      'more attachments than the limit',
      { attachments: Array(6).fill({ filename: 'a', contentBase64: '', contentType: 'a' }) }
    ],
    ['a correlation id past its length', { correlationId: longId }]
  ])('refuses %s', (_name, patch) => {
    expect(sendEmailJobSchema.safeParse({ ...email, ...patch }).success).toBe(false)
  })

  it('refuses a request for a magic link without an address, and one with a loose correlation id', () => {
    expect(requestMagicLinkJobSchema.safeParse({ email: 'a@example.com' }).success).toBe(true)
    expect(requestMagicLinkJobSchema.safeParse({}).success).toBe(false)
    expect(
      requestMagicLinkJobSchema.safeParse({ email: 'a@example.com', correlationId: longId }).success
    ).toBe(false)
  })

  it('refuses the delivery of an invitation whose ids are not ids', () => {
    expect(
      deliverInvitationEmailJobSchema.safeParse({ storeId: ID, invitationId: ID }).success
    ).toBe(true)
    expect(
      deliverInvitationEmailJobSchema.safeParse({ storeId: 's1', invitationId: 'i1' }).success
    ).toBe(false)
  })
})

describe('the schemas of the notification and profile jobs', () => {
  it('accept their own keys and refuse what is missing or is not an id', () => {
    expect(sendWebPushJobSchema.safeParse({ userId: ID, notificationId: ID }).success).toBe(true)
    expect(sendWebPushJobSchema.safeParse({ userId: ID }).success).toBe(false)
    expect(queueEmailDigestJobSchema.safeParse({ userId: ID, notificationId: 'x' }).success).toBe(
      false
    )
    expect(
      sendEmailDigestJobSchema.safeParse({ userId: ID, frequency: 'never-a-frequency' }).success
    ).toBe(false)
    expect(checkRemittancesJobSchema.safeParse({ storeId: ID }).success).toBe(true)
    expect(
      fetchCustomerProfileJobSchema.safeParse({ storeId: ID, identityId: ID, connectionRowId: ID })
        .success
    ).toBe(true)
    expect(fetchCustomerProfileJobSchema.safeParse({ storeId: ID, identityId: ID }).success).toBe(
      false
    )
  })

  it('drops a key it does not name instead of passing it on', () => {
    const parsed = checkRemittancesJobSchema.parse({ storeId: ID, extra: 'x' })
    expect(parsed).toEqual({ storeId: ID })
  })
})
