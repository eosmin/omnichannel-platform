import { createHmac } from 'node:crypto'

import { ToyChannelPlugin } from './toy.plugin'

// The key that signs a webhook of the toy channel is made when the process starts and never leaves it, so
// the only signature that can be valid is one made with that key: what the live check could not do
describe('the signature of a webhook of the toy channel', () => {
  const body = JSON.stringify({ hello: 'acme' })
  const sign = (plugin: ToyChannelPlugin, text: string) =>
    createHmac('sha256', plugin['webhookKey']).update(text).digest('hex')

  it('takes a body signed with the key of the process', () => {
    const plugin = new ToyChannelPlugin()
    expect(plugin.validateWebhookSignature(body, { 'x-acme-signature': sign(plugin, body) })).toBe(
      true
    )
  })

  it('refuses a signature of another body, of another process, a wrong one and none', () => {
    const plugin = new ToyChannelPlugin()
    const other = new ToyChannelPlugin()
    expect(
      plugin.validateWebhookSignature(body, { 'x-acme-signature': sign(plugin, `${body} `) })
    ).toBe(false)
    expect(plugin.validateWebhookSignature(body, { 'x-acme-signature': sign(other, body) })).toBe(
      false
    )
    expect(plugin.validateWebhookSignature(body, { 'x-acme-signature': 'abc' })).toBe(false)
    expect(plugin.validateWebhookSignature(body, {})).toBe(false)
  })
})
