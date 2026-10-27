import { InboundLimits, MessageType } from '@platform/core/domain'
import { ChannelEventTypes } from '@platform/plugins/sdk'

import { channelEventSchema } from './channel-event.schema'
import { inboundJobId } from './inbound-job'

const valid = {
  type: ChannelEventTypes.MESSAGE_RECEIVED,
  connectionId: 'c-1',
  channelIdentity: '50370000000',
  message: {
    externalId: 'm-1',
    type: MessageType.TEXT,
    content: 'hello',
    timestamp: '2026-10-27T10:00:00.000Z'
  },
  timestamp: '2026-10-27T10:00:00.000Z'
}

const withMessage = (over: object): object => ({ ...valid, message: { ...valid.message, ...over } })

describe('channelEventSchema', () => {
  it('takes an event that a plugin would return', () => {
    expect(channelEventSchema.safeParse(valid).success).toBe(true)
  })

  it.each([MessageType.SYSTEM, MessageType.INTERNAL_NOTE, MessageType.ORDER_SUMMARY])(
    'refuses a customer message of the type %s, which only the platform writes',
    type => {
      expect(channelEventSchema.safeParse(withMessage({ type })).success).toBe(false)
    }
  )

  it.each([
    ['a field it does not know', { ...valid, storeId: 'someone-else' }],
    ['a received event with no message', { ...valid, message: undefined }],
    ['a delivered event with no status', { ...valid, type: ChannelEventTypes.MESSAGE_DELIVERED }],
    ['a text message with no text', withMessage({ content: '  ' })],
    [
      'a text message that carries media',
      withMessage({ media: { ref: 'r', contentType: 'image/png', filename: null } })
    ],
    ['an image with no media', withMessage({ type: MessageType.IMAGE, content: null })],
    ['an empty connection', { ...valid, connectionId: '' }],
    ['a date that is not one', withMessage({ timestamp: 'yesterday' })],
    [
      'text past the limit',
      withMessage({ content: 'x'.repeat(InboundLimits.CONTENT_MAX_LENGTH + 1) })
    ],
    [
      'metadata past the limit',
      withMessage({ metadata: { big: 'x'.repeat(InboundLimits.METADATA_MAX_BYTES) } })
    ],
    [
      'a media ref past the limit',
      withMessage({
        media: {
          ref: 'x'.repeat(InboundLimits.MEDIA_REF_MAX_LENGTH + 1),
          contentType: 'image/png',
          filename: null
        }
      })
    ]
  ])('refuses %s', (_label, event) => {
    expect(channelEventSchema.safeParse(event).success).toBe(false)
  })
})

describe('inboundJobId', () => {
  const parse = (event: object) => channelEventSchema.parse(event)

  it('is the same for an event delivered twice', () => {
    expect(inboundJobId('test_channel', parse(valid))).toBe(
      inboundJobId('test_channel', parse(valid))
    )
  })

  it('differs by plugin, connection and message', () => {
    const base = inboundJobId('test_channel', parse(valid))
    expect(inboundJobId('other_channel', parse(valid))).not.toBe(base)
    expect(inboundJobId('test_channel', parse({ ...valid, connectionId: 'c-2' }))).not.toBe(base)
    expect(inboundJobId('test_channel', parse(withMessage({ externalId: 'm-2' })))).not.toBe(base)
  })

  it('cannot be forged by moving a separator between two parts', () => {
    const a = parse({
      ...valid,
      connectionId: 'a',
      message: { ...valid.message, externalId: 'b|c' }
    })
    const b = parse({
      ...valid,
      connectionId: 'a|b',
      message: { ...valid.message, externalId: 'c' }
    })
    expect(inboundJobId('test_channel', a)).not.toBe(inboundJobId('test_channel', b))
  })
})
