import { Locales } from '@platform/core/i18n'

import { sampleOrderMessageSource } from './message-sample'
import { orderSummaryLines, renderOrderSummaryPdf } from './order-summary-document'

describe('the order summary document', () => {
  it('lists what the order has, in the language of the store', () => {
    const lines = orderSummaryLines(sampleOrderMessageSource(Locales.ES), Locales.ES)
    expect(lines.map(line => line.label)).toEqual([
      'Pedido',
      'Cliente',
      'Artículos',
      '',
      'Total',
      'Por cobrar en la entrega',
      'Dirección de envío',
      'Fecha de entrega'
    ])
  })

  it('says the values of the order, one item per row', () => {
    const lines = orderSummaryLines(sampleOrderMessageSource(Locales.EN), Locales.EN)
    expect(lines.map(line => line.value)).toEqual([
      'ORD-1042',
      'Maria Lopez',
      '1 × Running shoes (Size 40) — $45.00',
      '2 × Sports socks — $15.00',
      '$60.00',
      '$60.00',
      '5th Street No. 10, Escalon, San Salvador, SV',
      'Wednesday, October 28'
    ])
  })

  it('leaves out the rows an order has no value for', () => {
    const lines = orderSummaryLines(
      {
        ...sampleOrderMessageSource(Locales.EN),
        customerName: null,
        codAmountCents: null,
        shippingAddress: null,
        scheduledDeliveryDate: null
      },
      Locales.EN
    )
    expect(lines.map(line => line.label)).toEqual(['Order', 'Items', '', 'Total'])
  })

  it('draws a PDF', async () => {
    const file = await renderOrderSummaryPdf(sampleOrderMessageSource(Locales.EN), Locales.EN)
    expect(Buffer.from(file.subarray(0, 5)).toString('latin1')).toBe('%PDF-')
  })
})
