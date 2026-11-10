import { widgetMessageSchema } from './widget-message'
import { widgetBootstrapSchema, widgetDownloadSchema, widgetUploadSchema } from './widget.schemas'

// The bodies of the public doors of the widget are the only thing between a script on any site and the api
// before the site key is looked at: what they refuse is pinned here, wherever the controllers live
describe('the bodies of the public doors', () => {
  const visitorId = '33333333-3333-4333-8333-333333333333'

  it('takes a well-formed bootstrap and refuses an extra field, a long key and a bad visitor id', () => {
    expect(widgetBootstrapSchema.safeParse({ siteKey: 'site', visitorId }).success).toBe(true)
    expect(widgetBootstrapSchema.safeParse({ siteKey: 'site', visitorId, extra: 1 }).success).toBe(
      false
    )
    expect(widgetBootstrapSchema.safeParse({ siteKey: 'k'.repeat(65), visitorId }).success).toBe(
      false
    )
    expect(widgetBootstrapSchema.safeParse({ siteKey: '', visitorId }).success).toBe(false)
    expect(widgetBootstrapSchema.safeParse({ siteKey: 'site', visitorId: '../x' }).success).toBe(
      false
    )
  })

  const upload = {
    visitorToken: 't',
    filename: 'a.png',
    contentType: 'image/png',
    fileSizeBytes: 10
  }

  it('takes a well-formed upload and refuses the sizes, lengths and extras it bounds', () => {
    expect(widgetUploadSchema.safeParse(upload).success).toBe(true)
    for (const bad of [
      { ...upload, fileSizeBytes: 0 },
      { ...upload, fileSizeBytes: 1.5 },
      { ...upload, visitorToken: 't'.repeat(513) },
      { ...upload, filename: 'f'.repeat(256) },
      { ...upload, contentType: 'c'.repeat(128) },
      { ...upload, extra: true }
    ]) {
      expect(widgetUploadSchema.safeParse(bad).success).toBe(false)
    }
  })

  it('takes a download by uuid and refuses anything else', () => {
    const mediaId = '33333333-3333-4333-8333-333333333333'
    expect(widgetDownloadSchema.safeParse({ visitorToken: 't', mediaId }).success).toBe(true)
    expect(widgetDownloadSchema.safeParse({ visitorToken: 't', mediaId: '../../x' }).success).toBe(
      false
    )
    expect(widgetDownloadSchema.safeParse({ visitorToken: 't', mediaId, extra: 1 }).success).toBe(
      false
    )
  })

  it('takes the fields a message declares and refuses any other, so that the doors are alike', () => {
    const message = { visitorToken: 't', clientMessageId: 'id-1', content: 'hola' }
    expect(widgetMessageSchema.safeParse(message).success).toBe(true)
    expect(
      widgetMessageSchema.safeParse({
        ...message,
        uploadIds: [visitorId],
        profile: { name: 'Ana', email: 'a@b.co', phone: '+5215555550100' }
      }).success
    ).toBe(true)
    for (const extra of [{ extra: 1 }, { attachments: [] }, { profile: { name: 'a', x: 1 } }]) {
      expect(widgetMessageSchema.safeParse({ ...message, ...extra }).success).toBe(false)
    }
  })
})
