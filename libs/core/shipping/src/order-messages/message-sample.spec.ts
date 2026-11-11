import { OrderMessageVariables } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { Locales, SUPPORTED_LOCALES } from '@platform/core/i18n'

import { previewOrderMessage, sampleOrderMessageValues } from './message-sample'

describe('the sample order of the preview', () => {
  it.each(SUPPORTED_LOCALES)('has a value for every variable of the allowlist in %s', locale => {
    const values = sampleOrderMessageValues(locale)
    for (const name of Object.values(OrderMessageVariables)) {
      expect(values[name]).toBeTruthy()
    }
  })

  it('previews a body in the language of the template', () => {
    expect(
      previewOrderMessage('Hola {{customerName}}, llega el {{scheduledDeliveryDate}}', Locales.ES)
    ).toEqual({
      text: 'Hola María López, llega el miércoles 28 de octubre',
      variables: ['customerName', 'scheduledDeliveryDate']
    })
  })

  it('refuses what could not be saved', () => {
    expect(() => previewOrderMessage('{{nope}}', Locales.EN)).toThrow(
      expect.objectContaining({ code: ErrorCodes.ORDER_MESSAGE_VARIABLE_UNKNOWN }) as Error
    )
  })
})
