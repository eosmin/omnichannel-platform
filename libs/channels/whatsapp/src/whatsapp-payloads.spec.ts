import { ErrorCodes } from '@platform/core/errors'
import { PluginError } from '@platform/plugins/sdk'

import {
  buttonsPayload,
  locationPayload,
  mediaPayload,
  readReceiptPayload,
  templatePayload,
  textPayload
} from './whatsapp-payloads'

const to = '15550001111'
const key = { idempotencyKey: 'k' }

function refusalOf(build: () => unknown): PluginError {
  try {
    build()
  } catch (error) {
    if (error instanceof PluginError) return error
  }
  throw new Error('expected a PluginError')
}

describe('whatsapp payloads', () => {
  describe('a customer addressed by user id', () => {
    it.each(['US.13491208655302741918', 'BR.ENT.9988776655'])(
      'sends to %s as the recipient and not as a number',
      id => {
        const body = textPayload({ channelIdentity: id, content: 'hi', ...key })
        expect(body).toMatchObject({ recipient: id })
        expect(body).not.toHaveProperty('to')
      }
    )

    it('keeps sending to a phone number as `to`', () => {
      const body = textPayload({ channelIdentity: to, content: 'hi', ...key })
      expect(body).toMatchObject({ to })
      expect(body).not.toHaveProperty('recipient')
    })
  })

  describe('length in characters, not in code units', () => {
    it('sends a text of 2100 emoji: 4200 code units, 2100 characters', () => {
      expect(() =>
        textPayload({ channelIdentity: to, content: '😀'.repeat(2100), ...key })
      ).not.toThrow()
    })

    it('refuses a text of 4097 emoji', () => {
      expect(() =>
        textPayload({ channelIdentity: to, content: '😀'.repeat(4097), ...key })
      ).toThrow(PluginError)
    })

    it('refuses a number longer than E.164 allows', () => {
      expect(() => textPayload({ channelIdentity: '1'.repeat(16), content: 'x', ...key })).toThrow(
        PluginError
      )
    })
  })

  describe('text', () => {
    it.each(['', '   ', 'x'.repeat(4097)])('refuses a text of %j', content => {
      expect(() => textPayload({ channelIdentity: to, content, ...key })).toThrow(PluginError)
    })

    it('addresses the customer, replies to a message and asks for no link preview', () => {
      expect(
        textPayload({ channelIdentity: to, content: 'hi', replyToExternalId: 'wamid.1', ...key })
      ).toEqual({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        context: { message_id: 'wamid.1' },
        type: 'text',
        text: { body: 'hi', preview_url: false }
      })
    })

    it.each(['+15550001111', '1555 000', 'abc', '', '1'.repeat(40)])(
      'refuses %p as a number, for good',
      identity => {
        const error = refusalOf(() =>
          textPayload({ channelIdentity: identity, content: 'x', ...key })
        )
        expect(error.code).toBe(ErrorCodes.CHANNEL_MESSAGE_FAILED)
        expect(error.retryable).toBe(false)
      }
    )
  })

  describe('media', () => {
    const media = {
      channelIdentity: to,
      mediaUrl: 'https://files.example.com/a.jpg',
      contentType: 'image/jpeg',
      filename: null,
      ...key
    }

    it.each([
      ['image/webp', 'document'],
      ['image/gif', 'document'],
      ['video/webm', 'document'],
      ['audio/wav', 'document'],
      ['Image/PNG', 'image'],
      ['image/jpeg; charset=binary', 'image'],
      ['video/mp4', 'video'],
      ['audio/ogg', 'audio']
    ])('sends %s as a %s, the kinds Meta takes', (contentType, kind) => {
      expect(mediaPayload({ ...media, contentType })).toMatchObject({ type: kind })
    })

    it('sends an image by link with its caption', () => {
      expect(mediaPayload({ ...media, caption: 'look' })).toMatchObject({
        type: 'image',
        image: { link: 'https://files.example.com/a.jpg', caption: 'look' }
      })
    })

    it('sends what it has no player for as a document with its filename', () => {
      expect(
        mediaPayload({ ...media, contentType: 'application/pdf', filename: 'invoice.pdf' })
      ).toMatchObject({ type: 'document', document: { filename: 'invoice.pdf' } })
    })

    it('does not put a filename on an image', () => {
      expect(mediaPayload({ ...media, filename: 'a.jpg' })).not.toHaveProperty('image.filename')
    })

    it('refuses a url that is not https', () => {
      expect(
        refusalOf(() => mediaPayload({ ...media, mediaUrl: 'http://x.test/a.jpg' })).retryable
      ).toBe(false)
      expect(refusalOf(() => mediaPayload({ ...media, mediaUrl: 'not a url' })).retryable).toBe(
        false
      )
    })

    it('refuses a url that carries credentials', () => {
      expect(() =>
        mediaPayload({ ...media, mediaUrl: 'https://user:pw@files.example.com/a.jpg' })
      ).toThrow(PluginError)
    })

    it('refuses a caption that is too long instead of cutting the reply', () => {
      expect(() => mediaPayload({ ...media, caption: 'x'.repeat(1025) })).toThrow(PluginError)
    })

    it('drops a blank caption the same way for every kind, audio included', () => {
      expect(mediaPayload({ ...media, caption: '   ' })).not.toHaveProperty('image.caption')
      expect(() =>
        mediaPayload({ ...media, contentType: 'audio/ogg', caption: '   ' })
      ).not.toThrow()
    })

    it('refuses a caption on audio, which cannot carry one', () => {
      const error = refusalOf(() =>
        mediaPayload({ ...media, contentType: 'audio/ogg', caption: 'x' })
      )
      expect(error.code).toBe(ErrorCodes.CHANNEL_CAPABILITY_UNSUPPORTED)
    })
  })

  describe('template', () => {
    const base = {
      channelIdentity: to,
      templateName: 'order_ready',
      language: 'es_MX',
      variables: [],
      ...key
    }

    it('sends the variables as the parameters of the body', () => {
      expect(templatePayload({ ...base, variables: ['Ana', '42'] })).toMatchObject({
        type: 'template',
        template: {
          name: 'order_ready',
          language: { code: 'es_MX' },
          components: [
            {
              type: 'body',
              parameters: [
                { type: 'text', text: 'Ana' },
                { type: 'text', text: '42' }
              ]
            }
          ]
        }
      })
    })

    it('sends no components without variables', () => {
      expect(templatePayload(base)).not.toHaveProperty('template.components')
    })
    it.each([[['']], [['a\nb']], [['a\tb']], [['x     y']]])(
      'refuses the variables %j, which Meta rejects',
      variables => {
        expect(() => templatePayload({ ...base, variables })).toThrow(PluginError)
      }
    )

    it.each([{ templateName: 'Order Ready' }, { templateName: '' }, { language: 'español' }])(
      'refuses %o',
      override => {
        expect(() => templatePayload({ ...base, ...override })).toThrow(PluginError)
      }
    )
  })

  describe('buttons', () => {
    const base = {
      channelIdentity: to,
      content: 'Choose',
      buttons: [{ id: 'a', title: 'Yes' }],
      ...key
    }

    it('sends reply buttons', () => {
      expect(buttonsPayload(base)).toMatchObject({
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: 'Choose' },
          action: { buttons: [{ type: 'reply', reply: { id: 'a', title: 'Yes' } }] }
        }
      })
    })

    it.each([
      { buttons: [{ id: 'a', title: '   ' }] },
      { buttons: [] },
      { content: '   ' },
      {
        buttons: [
          { id: 'same', title: 'A' },
          { id: 'same', title: 'B' }
        ]
      },
      { buttons: Array.from({ length: 4 }, (_, i) => ({ id: `${i}`, title: 'x' })) },
      { buttons: [{ id: 'a', title: 'x'.repeat(21) }] },
      { buttons: [{ id: '', title: 'x' }] },
      {
        buttons: [
          { id: 'a', title: 'Same' },
          { id: 'b', title: 'Same' }
        ]
      },
      { content: 'x'.repeat(1025) }
    ])('refuses %o', override => {
      expect(() => buttonsPayload({ ...base, ...override })).toThrow(PluginError)
    })
  })

  describe('location', () => {
    it('sends the coordinates and the name', () => {
      expect(
        locationPayload({
          channelIdentity: to,
          latitude: 19.43,
          longitude: -99.13,
          name: 'Shop',
          ...key
        })
      ).toMatchObject({
        type: 'location',
        location: { latitude: 19.43, longitude: -99.13, name: 'Shop' }
      })
    })

    it.each([
      { latitude: 91, longitude: 0 },
      { latitude: 0, longitude: -181 },
      { latitude: Number.NaN, longitude: 0 }
    ])('refuses %o', coordinates => {
      expect(() => locationPayload({ channelIdentity: to, ...coordinates, ...key })).toThrow(
        PluginError
      )
    })
  })

  it.each(['', '   ', 'w'.repeat(300)])('refuses to mark %j as read', id => {
    expect(() => readReceiptPayload(id)).toThrow(PluginError)
  })

  it('marks a message as read', () => {
    expect(readReceiptPayload('wamid.1')).toEqual({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: 'wamid.1'
    })
  })
})
