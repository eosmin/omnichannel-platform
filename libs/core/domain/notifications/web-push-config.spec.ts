import { webPushConfig } from './web-push-config'

describe('webPushConfig', () => {
  const keys = { VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv' }

  it('is off without the keys', () => {
    expect(webPushConfig({ EMAIL_FROM: 'a@b.co' }).vapid).toBeNull()
    expect(webPushConfig({ EMAIL_FROM: 'a@b.co', VAPID_PUBLIC_KEY: 'pub' }).vapid).toBeNull()
  })

  it('uses a bare sender address as the contact', () => {
    expect(webPushConfig({ EMAIL_FROM: 'noreply@platform.local', ...keys }).vapid).toEqual({
      subject: 'mailto:noreply@platform.local',
      publicKey: 'pub',
      privateKey: 'priv'
    })
  })

  it('takes the address out of "Name <address>"', () => {
    expect(
      webPushConfig({ EMAIL_FROM: 'Platform <noreply@platform.local>', ...keys }).vapid?.subject
    ).toBe('mailto:noreply@platform.local')
  })
})
