import { NotificationTypes } from '@platform/core/notifications'

import { putPreferencesBodySchema } from './notifications.schemas'

const on = { inApp: true, push: true, email: true, sound: true }
const off = { inApp: false, push: false, email: false, sound: false }

describe('putPreferencesBodySchema, the alerts that cannot be turned off', () => {
  it.each([NotificationTypes.FINANCE_CHAIN_BROKEN, NotificationTypes.MEDIA_INFECTED])(
    'refuses to turn off a channel of %s that it is delivered by',
    type => {
      expect(putPreferencesBodySchema.safeParse({ types: [{ type, ...off }] }).success).toBe(false)
    }
  )

  it('refuses each locked channel turned off on its own', () => {
    const chain = NotificationTypes.FINANCE_CHAIN_BROKEN
    expect(
      putPreferencesBodySchema.safeParse({ types: [{ type: chain, ...on, email: false }] }).success
    ).toBe(false)
    expect(
      putPreferencesBodySchema.safeParse({ types: [{ type: chain, ...on, inApp: false }] }).success
    ).toBe(false)
    const infected = NotificationTypes.MEDIA_INFECTED
    expect(
      putPreferencesBodySchema.safeParse({ types: [{ type: infected, ...on, push: false }] })
        .success
    ).toBe(false)
  })

  it('lets the person turn off what is not locked of a locked type, and keeps it on otherwise', () => {
    const chain = NotificationTypes.FINANCE_CHAIN_BROKEN
    expect(
      putPreferencesBodySchema.safeParse({ types: [{ type: chain, ...on, sound: false }] }).success
    ).toBe(true)
    expect(
      putPreferencesBodySchema.safeParse({
        types: [{ type: NotificationTypes.MEDIA_INFECTED, ...on }]
      }).success
    ).toBe(true)
  })

  it('lets the person turn off every other critical alert', () => {
    for (const type of [
      NotificationTypes.DSR_DEADLINE_APPROACHING,
      NotificationTypes.WEBHOOK_AUTO_DISABLED
    ]) {
      expect(putPreferencesBodySchema.safeParse({ types: [{ type, ...off }] }).success).toBe(true)
    }
  })
})
