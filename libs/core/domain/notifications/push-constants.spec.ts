import { NotificationTypes } from './notification-constants'
import {
  clipPushText,
  isBase64UrlOfBytes,
  isPushEndpoint,
  normalizePushEndpoint,
  pushTag
} from './push-constants'

describe('isPushEndpoint', () => {
  it.each([
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://web.push.apple.com/QAbc',
    'https://wns2-par02p.notify.windows.com/w/?token=abc',
    'https://FCM.googleapis.com:443/fcm/send/abc'
  ])('accepts the endpoint of a push service: %s', endpoint => {
    expect(isPushEndpoint(endpoint)).toBe(true)
  })

  it.each([
    'http://fcm.googleapis.com/fcm/send/abc',
    'https://169.254.169.254/latest/meta-data',
    'https://localhost/push',
    'https://internal.example.com/push',
    'https://fcm.googleapis.com.evil.example/push',
    'https://evilnotify.windows.com.example/push',
    'https://notify.windows.com/w',
    'https://user:pass@fcm.googleapis.com/fcm/send/abc',
    'https://fcm.googleapis.com:8443/fcm/send/abc',
    'not a url',
    ''
  ])('refuses a host that is not a push service: %s', endpoint => {
    expect(isPushEndpoint(endpoint)).toBe(false)
  })

  it('refuses an endpoint over the length limit', () => {
    expect(isPushEndpoint(`https://fcm.googleapis.com/${'a'.repeat(2100)}`)).toBe(false)
  })
})

describe('pushTag', () => {
  it('groups the notifications of one resource', () => {
    expect(pushTag(NotificationTypes.CONVERSATION_ASSIGNED, 'c1', 'n1')).toBe(
      'conversation.assigned:c1'
    )
  })

  it('keeps a notification without a resource on its own', () => {
    expect(pushTag(NotificationTypes.EXPORT_READY, null, 'n1')).toBe('export.ready:n1')
  })
})

describe('clipPushText', () => {
  it('leaves a short text alone', () => {
    expect(clipPushText('hello', 10)).toBe('hello')
  })

  it('cuts a long one with an ellipsis, by characters and not by bytes', () => {
    expect(clipPushText('ñandú'.repeat(3), 6)).toBe('ñandú…')
  })
})

describe('isBase64UrlOfBytes', () => {
  it('accepts unpadded base64url of the size, and nothing else', () => {
    expect(isBase64UrlOfBytes('a'.repeat(22), 16)).toBe(true)
    expect(isBase64UrlOfBytes('B'.repeat(87), 65)).toBe(true)
    expect(isBase64UrlOfBytes('a'.repeat(21), 16)).toBe(false)
    expect(isBase64UrlOfBytes(`${'a'.repeat(21)}=`, 16)).toBe(false)
    expect(isBase64UrlOfBytes(`${'a'.repeat(21)}+`, 16)).toBe(false)
    expect(isBase64UrlOfBytes('', 16)).toBe(false)
  })
})

describe('normalizePushEndpoint', () => {
  it('writes the url the way the checking parser reads it', () => {
    expect(normalizePushEndpoint('https://FCM.googleapis.com:443/fcm/send/a b')).toBe(
      'https://fcm.googleapis.com/fcm/send/a%20b'
    )
  })
})
