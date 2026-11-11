import { LabelFormat, LabelPageSizesMm } from '@platform/core/domain'
import { LabelElementKinds, type LabelLayout, type LabelTextElement } from '@platform/plugins/sdk'

import { fitLine, LabelRenderError } from './label-fit'
import { createLabelMeter, renderLabelPdf } from './label-pdf'

function text(overrides: Partial<LabelTextElement> = {}): LabelTextElement {
  return {
    kind: LabelElementKinds.TEXT,
    xMm: 5,
    yMm: 40,
    widthMm: 90,
    sizePt: 14,
    bold: true,
    align: 'left',
    lines: ['Ana Perez', 'Calle 5 No 10, Santa Tecla'],
    lineHeightMm: 6,
    ...overrides
  }
}

// What a carrier lays out: a rule, a barcode between its quiet zones, and the text of a guide
function layout(elements: LabelLayout['elements'] = [text()]): LabelLayout {
  return {
    format: LabelFormat.PDF_100X150,
    widthMm: 100,
    heightMm: 150,
    elements: [
      { kind: LabelElementKinds.RULE, xMm: 5, yMm: 35, widthMm: 90 },
      {
        kind: LabelElementKinds.BARCODE,
        xMm: 5,
        yMm: 5,
        widthMm: 90,
        heightMm: 20,
        modules: [2, 1, 1, 2, 3, 1, 1, 1, 2],
        quietZoneModules: 10
      },
      ...elements
    ]
  }
}

const header = (file: Uint8Array): string => Buffer.from(file.subarray(0, 5)).toString('latin1')

describe('createLabelMeter', () => {
  it('measures with the real widths of the font: a W is wider than an i, and bold wider than regular', () => {
    const meter = createLabelMeter()
    expect(meter('WWWW', 10, false)).toBeGreaterThan(meter('iiii', 10, false))
    expect(meter('Wide', 10, true)).toBeGreaterThan(meter('Wide', 10, false))
  })

  it('shrinks the widest capitals to the box the carrier gave them', () => {
    const meter = createLabelMeter()
    const element = text({ lines: ['W'.repeat(40)] })
    const fitted = fitLine(element, 'W'.repeat(40), meter)
    expect(fitted.sizePt).toBeLessThan(element.sizePt)
    expect(meter('W'.repeat(40), fitted.sizePt, true)).toBeLessThanOrEqual(
      element.widthMm * (72 / 25.4)
    )
  })
})

describe('renderLabelPdf', () => {
  it('draws the layout of a guide as a PDF', async () => {
    const file = await renderLabelPdf(layout())
    expect(header(file)).toBe('%PDF-')
    expect(file.byteLength).toBeGreaterThan(500)
  })

  it('draws the page at the size of the layout, for every page format', async () => {
    for (const format of Object.values(LabelFormat)) {
      const { widthMm, heightMm } = LabelPageSizesMm[format]
      const file = await renderLabelPdf({ ...layout(), format, widthMm, heightMm })
      const box = /\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(
        Buffer.from(file).toString('latin1')
      )
      expect(Number(box?.[1])).toBeCloseTo(widthMm * (72 / 25.4), 1)
      expect(Number(box?.[2])).toBeCloseTo(heightMm * (72 / 25.4), 1)
    }
  })

  it('draws text in both faces and both alignments', async () => {
    const file = await renderLabelPdf(
      layout([
        text({ bold: false, align: 'center', lines: ['PAID'] }),
        text({ yMm: 80, lines: ['Collect $25.00'] })
      ])
    )
    expect(header(file)).toBe('%PDF-')
  })

  it('draws a name made of the widest capitals by shrinking it, not by cutting it', async () => {
    const file = await renderLabelPdf(layout([text({ lines: ['W'.repeat(40), 'M'.repeat(30)] })]))
    expect(header(file)).toBe('%PDF-')
  })

  it('refuses a line that would need type too small to read', async () => {
    await expect(
      renderLabelPdf(layout([text({ widthMm: 5, lines: ['W'.repeat(80)] })]))
    ).rejects.toThrow(LabelRenderError)
  })

  it('refuses a layout it cannot draw whole', async () => {
    await expect(renderLabelPdf({ ...layout(), widthMm: 0 })).rejects.toThrow(LabelRenderError)
  })
})
