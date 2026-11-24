import type { PrismaService } from '@platform/core/database'
import { NotificationTypes } from '@platform/core/notifications'

import { NotificationPreferencesService } from './notification-preferences.service'

const off = { inApp: false, push: false, email: false, sound: false }
const USER = 'u-1'
const STORE = 's-1'

function build(row: Record<string, unknown> | null) {
  const client = {
    notificationPreference: {
      findUnique: jest.fn().mockResolvedValue(row),
      findMany: jest.fn().mockResolvedValue(row === null ? [] : [{ userId: USER, ...row }])
    },
    userNotificationSettings: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([])
    }
  }
  return new NotificationPreferencesService({ client } as unknown as PrismaService)
}

describe('NotificationPreferencesService, the alerts that cannot be turned off (BAN-325)', () => {
  it('reads a stored off as on for the channels a locked type is delivered by', async () => {
    const service = build(off)
    await expect(
      service.resolve(USER, STORE, NotificationTypes.FINANCE_CHAIN_BROKEN)
    ).resolves.toEqual({
      inApp: true,
      push: false,
      email: true,
      sound: false
    })
    await expect(service.resolve(USER, STORE, NotificationTypes.MEDIA_INFECTED)).resolves.toEqual({
      inApp: true,
      push: true,
      email: false,
      sound: false
    })
  })

  it('does the same for the recipients of a group', async () => {
    const service = build(off)
    const context = await service.loadRecipients(
      [USER],
      STORE,
      NotificationTypes.FINANCE_CHAIN_BROKEN
    )
    expect(context.channels.get(USER)).toEqual({
      inApp: true,
      push: false,
      email: true,
      sound: false
    })
  })

  it('leaves an unlocked critical alert as the person chose it', async () => {
    const service = build(off)
    await expect(
      service.resolve(USER, STORE, NotificationTypes.DSR_DEADLINE_APPROACHING)
    ).resolves.toEqual(off)
    await expect(
      service.resolve(USER, STORE, NotificationTypes.WEBHOOK_AUTO_DISABLED)
    ).resolves.toEqual(off)
  })

  it('shows the locked channels on in the preferences view', async () => {
    const service = build(null)
    const view = await service.get(USER, STORE)
    const chain = view.types.find(row => row.type === NotificationTypes.FINANCE_CHAIN_BROKEN)
    expect(chain).toMatchObject({ inApp: true, email: true })
  })
})
