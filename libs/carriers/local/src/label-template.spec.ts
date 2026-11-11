import { LabelFormat, LabelPageSizesMm, type LabelFormatType } from '@platform/core/domain'
import {
  type LabelBarcodeElement,
  type LabelElement,
  LabelElementKinds,
  type LabelInput,
  LabelPaymentKinds,
  type LabelTextElement
} from '@platform/plugins/sdk'

import { Code128, encodeCode128 } from './code128'
import { buildLocalLabelLayout, LabelLayoutError } from './label-template'

const texts = {
  from: 'From',
  to: 'To',
  collect: 'Collect',
  paid: 'PAID',
  order: 'Order',
  packages: 'Packages',
  service: 'Service',
  notes: 'Notes'
}

function input(overrides: Partial<LabelInput> = {}): LabelInput {
  return {
    format: LabelFormat.PDF_100X150,
    guideNumber: 'JM-000123',
    orderNumber: 'ORD-1001',
    sender: {
      name: 'Main warehouse',
      phone: '22223333',
      addressLines: ['1 Warehouse Rd', 'San Salvador']
    },
    recipient: {
      name: 'Ana Recipient',
      phones: ['71234567', '22123456'],
      addressLines: ['5 Customer St', 'Santa Tecla', 'La Libertad']
    },
    packageCount: 2,
    serviceLabel: 'Local delivery',
    payment: { kind: LabelPaymentKinds.COD, amountText: '$45.50' },
    texts,
    ...overrides
  }
}

const textsOf = (elements: readonly LabelElement[]): LabelTextElement[] =>
  elements.filter((e): e is LabelTextElement => e.kind === LabelElementKinds.TEXT)

const allText = (elements: readonly LabelElement[]): string =>
  textsOf(elements)
    .flatMap(e => e.lines)
    .join('\n')

describe('buildLocalLabelLayout', () => {
  it('puts the guide as a Code 128 barcode and as text', () => {
    const { elements } = buildLocalLabelLayout(input())
    const barcode = elements.find(
      (e): e is LabelBarcodeElement => e.kind === LabelElementKinds.BARCODE
    )
    expect(barcode?.modules).toEqual(encodeCode128('JM-000123'))
    expect(barcode?.quietZoneModules).toBe(Code128.QUIET_ZONE_MODULES)
    expect(textsOf(elements).some(e => e.lines.includes('JM-000123'))).toBe(true)
  })

  it('prints the amount to collect in large type for a COD order, and not the word for paid', () => {
    const { elements } = buildLocalLabelLayout(input())
    const amount = textsOf(elements).find(e => e.lines.includes('$45.50'))
    expect(amount?.bold).toBe(true)
    const others = textsOf(elements).filter(e => e !== amount)
    // The amount is the biggest thing on the label
    expect(Math.max(...others.map(e => e.sizePt))).toBeLessThan(amount?.sizePt ?? 0)
    expect(allText(elements)).toContain('Collect')
    expect(allText(elements)).not.toContain('PAID')
  })

  it('prints the word for paid, and no amount, for a prepaid order', () => {
    const { elements } = buildLocalLabelLayout(input({ payment: { kind: LabelPaymentKinds.PAID } }))
    expect(allText(elements)).toContain('PAID')
    expect(allText(elements)).not.toContain('Collect')
    expect(allText(elements)).not.toContain('$')
  })

  it('prints the recipient: name, every phone and the full address', () => {
    // A long address wraps over lines: it is whole once the lines are read as one
    const text = allText(buildLocalLabelLayout(input()).elements).replace(/\s+/g, ' ')
    expect(text).toContain('Ana Recipient')
    expect(text).toContain('71234567')
    expect(text).toContain('22123456')
    expect(text).toContain('5 Customer St, Santa Tecla, La Libertad')
  })

  it('prints the order, the packages, the service, the sender and the notes', () => {
    const text = allText(buildLocalLabelLayout(input({ notes: 'Ring twice' })).elements)
    expect(text).toContain('Order: ORD-1001')
    expect(text).toContain('Packages: 2')
    expect(text).toContain('Service: Local delivery')
    expect(text).toContain('From: Main warehouse')
    expect(text).toContain('Notes: Ring twice')
  })

  it('prints no notes line when there are none or they are blank', () => {
    expect(allText(buildLocalLabelLayout(input()).elements)).not.toContain('Notes')
    expect(allText(buildLocalLabelLayout(input({ notes: '   ' })).elements)).not.toContain('Notes')
  })

  it('says nothing of its own: every word comes from the texts it was given', () => {
    const swapped = Object.fromEntries(Object.keys(texts).map(key => [key, `«${key}»`]))
    for (const payment of [
      { kind: LabelPaymentKinds.PAID } as const,
      { kind: LabelPaymentKinds.COD, amountText: '45.50' } as const
    ]) {
      const text = allText(
        buildLocalLabelLayout(input({ texts: swapped as typeof texts, notes: 'n', payment }))
          .elements
      )
      for (const word of Object.values(texts)) expect(text).not.toContain(word)
      // ... and the swapped words are the ones printed where they belong
      expect(text).toContain('«from»')
      expect(text).toContain(payment.kind === LabelPaymentKinds.PAID ? '«paid»' : '«collect»')
    }
  })

  it('is pure: the same input gives the same layout and the input is left alone', () => {
    const params = input({ notes: 'Ring twice' })
    const before = structuredClone(params)
    expect(buildLocalLabelLayout(params)).toEqual(buildLocalLabelLayout(params))
    expect(params).toEqual(before)
  })

  describe.each(Object.values(LabelFormat) as LabelFormatType[])('on a %s page', format => {
    const { widthMm, heightMm } = LabelPageSizesMm[format]
    const long = 'Colonia La Esperanza, Pasaje 7, Casa 12-B, entre la tienda y el parque central'

    it('gives the layout the size of the page', () => {
      const layout = buildLocalLabelLayout(input({ format }))
      expect([layout.widthMm, layout.heightMm]).toEqual([widthMm, heightMm])
    })

    it('keeps everything inside the page, even with a long address, long notes and a long sender', () => {
      const { elements } = buildLocalLabelLayout(
        input({
          format,
          sender: { name: long, phone: '22223333', addressLines: [long, long] },
          recipient: {
            name: 'Ana Recipient',
            phones: ['71234567', '22123456', '60001111', '70001111'],
            addressLines: [long, long]
          },
          notes: long.repeat(10)
        })
      )
      for (const element of elements) {
        expect(element.xMm).toBeGreaterThanOrEqual(0)
        expect(element.xMm + element.widthMm).toBeLessThanOrEqual(widthMm)
        expect(element.yMm).toBeGreaterThanOrEqual(0)
        const bottom =
          element.kind === LabelElementKinds.TEXT
            ? element.yMm + element.lines.length * element.lineHeightMm
            : element.kind === LabelElementKinds.BARCODE
              ? element.yMm + element.heightMm
              : element.yMm
        expect(bottom).toBeLessThanOrEqual(heightMm)
      }
    })

    it('keeps the barcode, the guide and the amount, however long the rest is', () => {
      const { elements } = buildLocalLabelLayout(
        input({
          format,
          recipient: { name: 'Ana', phones: ['71234567'], addressLines: [long, long] },
          notes: long.repeat(10)
        })
      )
      expect(allText(elements)).toContain('JM-000123')
      expect(allText(elements)).toContain('$45.50')
      expect(elements.some(e => e.kind === LabelElementKinds.BARCODE)).toBe(true)
    })
  })

  it('cuts a word longer than a line instead of leaving the page', () => {
    const { elements } = buildLocalLabelLayout(
      input({ recipient: { name: 'Ana', phones: ['71234567'], addressLines: ['x'.repeat(300)] } })
    )
    // 300 characters become several lines that fit the box, not one that runs off the page
    const address = textsOf(elements).find(e => e.lines.join('').includes('xxxxxxxx'))
    expect(address?.lines.length).toBeGreaterThan(1)
    const emMm = (address?.sizePt ?? 0) * (25.4 / 72)
    for (const line of address?.lines ?? []) {
      expect(line.length * emMm * 0.72).toBeLessThanOrEqual(address?.widthMm ?? 0)
    }
  })

  it('marks notes that do not fit with an ellipsis', () => {
    const text = allText(buildLocalLabelLayout(input({ notes: ' word'.repeat(200) })).elements)
    expect(text).toContain('…')
  })
})

describe('what the label never cuts', () => {
  it('keeps a long amount whole by making it smaller, never with an ellipsis', () => {
    const amount = '$1,234,567,890.00'
    const { elements } = buildLocalLabelLayout(
      input({ payment: { kind: LabelPaymentKinds.COD, amountText: amount } })
    )
    expect(allText(elements)).toContain(amount)
    expect(allText(elements)).not.toContain('…')
  })

  it('throws instead of printing an amount that cannot fit', () => {
    expect(() =>
      buildLocalLabelLayout(
        input({ payment: { kind: LabelPaymentKinds.COD, amountText: '9'.repeat(200) } })
      )
    ).toThrow(LabelLayoutError)
  })

  it('keeps every phone and the whole recipient name or throws', () => {
    const phones = Array.from({ length: 4 }, (_, i) => `7123456${i}`)
    const text = allText(
      buildLocalLabelLayout(
        input({ recipient: { name: 'Ana Recipient', phones, addressLines: ['5 Customer St'] } })
      ).elements
    )
    for (const phone of phones) expect(text).toContain(phone)
    expect(() =>
      buildLocalLabelLayout(
        input({ recipient: { name: 'A'.repeat(500), phones, addressLines: ['x'] } })
      )
    ).toThrow(LabelLayoutError)
  })

  it('wraps for the capitals of an address: no line is wider than its box', () => {
    const { elements } = buildLocalLabelLayout(
      input({
        recipient: {
          name: 'ANA RECIPIENT',
          phones: ['71234567'],
          addressLines: ['COLONIA MEDICA AVENIDA MASFERRER NORTE 1234567890 EDIFICIO WWW']
        }
      })
    )
    // Wide capitals of Helvetica are about 0.72 em (regular) and 0.78 em (bold) wide
    for (const element of textsOf(elements)) {
      const emMm = element.sizePt * (25.4 / 72)
      for (const line of element.lines) {
        expect(line.length * emMm * (element.bold ? 0.78 : 0.72)).toBeLessThanOrEqual(
          element.widthMm
        )
      }
    }
  })

  it('refuses a guide it cannot draw with a typed error', () => {
    expect(() => buildLocalLabelLayout(input({ guideNumber: '' }))).toThrow(LabelLayoutError)
    expect(() => buildLocalLabelLayout(input({ guideNumber: 'JM-ñ' }))).toThrow(LabelLayoutError)
  })

  it('does not split a character made of two code units', () => {
    const text = allText(
      buildLocalLabelLayout(
        input({
          recipient: { name: 'Ana', phones: ['71234567'], addressLines: ['😀'.repeat(200)] }
        })
      ).elements
    )
    expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
  })
})
