import { MessageMetadataKeys } from '@platform/core/domain'

import { unsupportedLogFields, unsupportedShapeOf } from './unsupported-shape'

const SHAPE = {
  messageFields: ['mid', 'attachments'],
  attachments: [{ type: 'ig_place', fields: ['type', 'payload'], payloadFields: ['coordinates'] }]
}

describe('unsupportedShapeOf', () => {
  it('keeps the names of the element of a template', () => {
    const shape = {
      messageFields: ['mid'],
      attachments: [
        {
          type: 'template',
          fields: ['type', 'payload'],
          payloadFields: ['generic'],
          elementFields: ['title', 'default_action', 'default_action.url']
        }
      ]
    }
    expect(
      unsupportedShapeOf({
        metadata: {
          [MessageMetadataKeys.UNSUPPORTED_TYPE]: 'template',
          [MessageMetadataKeys.UNSUPPORTED_SHAPE]: shape
        }
      })
    ).toEqual({ unsupportedType: 'template', shape })
  })

  it('takes the type and the names a message of a type that cannot be read carried', () => {
    expect(
      unsupportedShapeOf({
        metadata: {
          [MessageMetadataKeys.UNSUPPORTED_TYPE]: 'ig_place',
          [MessageMetadataKeys.UNSUPPORTED_SHAPE]: SHAPE,
          attachmentUrl: 'https://l.instagram.com/?u=secret'
        }
      })
    ).toEqual({ unsupportedType: 'ig_place', shape: SHAPE })
  })

  it('takes the type alone from a channel that sends no shape: the line of the log is still worth writing', () => {
    expect(
      unsupportedShapeOf({ metadata: { [MessageMetadataKeys.UNSUPPORTED_TYPE]: 'order' } })
    ).toEqual({ unsupportedType: 'order' })
  })

  it('takes nothing from a message that was read', () => {
    expect(unsupportedShapeOf({})).toBeNull()
    expect(unsupportedShapeOf({ metadata: { attachmentType: 'ig_post' } })).toBeNull()
  })

  it('takes nothing that is not names: a value of the customer never reaches the log', () => {
    const forged = {
      [MessageMetadataKeys.UNSUPPORTED_TYPE]: 'ig_place',
      [MessageMetadataKeys.UNSUPPORTED_SHAPE]: {
        messageFields: ['mid', 'a long text with spaces'],
        attachments: [{ type: 'ig_place', fields: [], payloadFields: ['https://x.test/?t=1'] }]
      }
    }
    expect(unsupportedShapeOf({ metadata: forged })).toBeNull()
  })
})

describe('unsupportedLogFields', () => {
  it('is the plugin, the type and the names: no id of the message, the connection or the customer', () => {
    const fields = unsupportedLogFields('instagram', { unsupportedType: 'ig_place', shape: SHAPE })

    expect(fields).toEqual({ pluginId: 'instagram', unsupportedType: 'ig_place', shape: SHAPE })
    for (const key of ['externalId', 'connectionId', 'channelIdentity']) {
      expect(fields).not.toHaveProperty(key)
    }
  })

  it('leaves the shape out when the channel sent none', () => {
    expect(unsupportedLogFields('whatsapp', { unsupportedType: 'order' })).toEqual({
      pluginId: 'whatsapp',
      unsupportedType: 'order'
    })
  })
})
