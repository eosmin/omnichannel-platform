import { MessageMetadataKeys } from '@platform/core/domain'

import { unsupportedShapeOf } from './unsupported-shape'

const SHAPE = {
  messageFields: ['mid', 'attachments'],
  attachments: [{ type: 'ig_place', fields: ['type', 'payload'], payloadFields: ['coordinates'] }]
}

describe('unsupportedShapeOf', () => {
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
