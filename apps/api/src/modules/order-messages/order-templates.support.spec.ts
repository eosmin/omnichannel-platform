import { OrderMessageWarnings } from '@platform/core/domain'

import { readChannelTemplate, templateWarnings } from './order-templates.support'

const LINK = {
  pluginId: 'any_channel',
  name: 'order_update',
  language: 'es',
  variables: ['orderNumber' as const]
}

describe('templateWarnings', () => {
  it('warns about an automatic template that uses the scheduled delivery date in its text', () => {
    expect(
      templateWarnings({
        body: 'Llega {{scheduledDeliveryDate}}',
        autoSend: true,
        channelTemplate: null
      })
    ).toEqual([OrderMessageWarnings.AUTO_SEND_NEEDS_SCHEDULED_DATE])
  })

  it('warns when only the variables of the approved template use it', () => {
    expect(
      templateWarnings({
        body: 'Hola',
        autoSend: true,
        channelTemplate: { ...LINK, variables: ['orderNumber', 'scheduledDeliveryDate'] }
      })
    ).toEqual([OrderMessageWarnings.AUTO_SEND_NEEDS_SCHEDULED_DATE])
  })

  it('does not warn when the template is not automatic or does not use the date', () => {
    expect(
      templateWarnings({
        body: '{{scheduledDeliveryDate}}',
        autoSend: false,
        channelTemplate: null
      })
    ).toEqual([])
    expect(
      templateWarnings({ body: '{{orderNumber}}', autoSend: true, channelTemplate: LINK })
    ).toEqual([])
  })
})

describe('readChannelTemplate', () => {
  it('reads what the service wrote', () => {
    expect(readChannelTemplate(LINK)).toEqual(LINK)
  })

  it('reads a link with a variable that is not in the allowlist as no link: the variables are positional, none can be dropped', () => {
    expect(readChannelTemplate({ ...LINK, variables: ['orderNumber', 'secret'] })).toBeNull()
    expect(readChannelTemplate({ ...LINK, variables: [1] })).toBeNull()
  })

  it.each([
    ['null', null],
    ['text', 'x'],
    ['a link without its name', { ...LINK, name: undefined }],
    ['a link whose variables are not a list', { ...LINK, variables: 'orderNumber' }]
  ])('reads %s as no link', (_name, value) => {
    expect(readChannelTemplate(value)).toBeNull()
  })
})
