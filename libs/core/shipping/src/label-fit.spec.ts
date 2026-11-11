import { LabelElementKinds, type LabelLayout, type LabelTextElement } from '@platform/plugins/sdk'

import {
  assertLayoutFitsPage,
  fitLine,
  isDrawable,
  LabelRenderError,
  MM_TO_PT,
  type TextMeter
} from './label-fit'

// Every character is as wide as the size: the width of a line is its length times the size
const meter: TextMeter = (text, sizePt) => [...text].length * sizePt

function textElement(overrides: Partial<LabelTextElement> = {}): LabelTextElement {
  return {
    kind: LabelElementKinds.TEXT,
    xMm: 5,
    yMm: 5,
    widthMm: 40,
    sizePt: 10,
    bold: false,
    align: 'left',
    lines: ['x'],
    lineHeightMm: 4,
    ...overrides
  }
}

describe('fitLine', () => {
  it('keeps the size of a line that fits', () => {
    // 4 characters at 10 pt are 40 pt, a 40 mm box is about 113 pt
    expect(fitLine(textElement(), 'ABCD', meter)).toEqual({ text: 'ABCD', sizePt: 10 })
  })

  it('shrinks a line that is wider than its box so that it fits', () => {
    const element = textElement({ widthMm: 20 })
    const boxPt = 20 * MM_TO_PT
    const fitted = fitLine(element, 'A'.repeat(8), meter)
    expect(fitted.sizePt).toBeLessThan(10)
    expect(meter('A'.repeat(8), fitted.sizePt, false)).toBeLessThanOrEqual(boxPt)
  })

  it('passes the face to the meter', () => {
    const faces: boolean[] = []
    fitLine(textElement({ bold: true }), 'A', (_text, _size, bold) => {
      faces.push(bold)
      return 1
    })
    expect(faces).toEqual([true])
  })

  it('refuses a line that would need type too small to read', () => {
    const element = textElement({ widthMm: 10 })
    expect(() => fitLine(element, 'A'.repeat(200), meter)).toThrow(LabelRenderError)
  })
})

describe('assertLayoutFitsPage', () => {
  const layout = (elements: LabelLayout['elements'], widthMm = 100): LabelLayout => ({
    format: 'pdf_100x150',
    widthMm,
    heightMm: 150,
    elements
  })

  it('accepts a layout whose elements are on the page', () => {
    expect(() => assertLayoutFitsPage(layout([textElement()]))).not.toThrow()
  })

  it('refuses a page with no size', () => {
    expect(() => assertLayoutFitsPage(layout([], 0))).toThrow(LabelRenderError)
  })

  it('refuses an element that leaves the page on the right', () => {
    expect(() => assertLayoutFitsPage(layout([textElement({ xMm: 80, widthMm: 40 })]))).toThrow(
      LabelRenderError
    )
  })

  it('refuses an element at a negative position', () => {
    expect(() => assertLayoutFitsPage(layout([textElement({ xMm: -1 })]))).toThrow(LabelRenderError)
    expect(() => assertLayoutFitsPage(layout([textElement({ yMm: -1 })]))).toThrow(LabelRenderError)
  })

  it('refuses a barcode with no bars', () => {
    expect(() =>
      assertLayoutFitsPage(
        layout([
          {
            kind: LabelElementKinds.BARCODE,
            xMm: 5,
            yMm: 5,
            widthMm: 50,
            heightMm: 10,
            modules: [],
            quietZoneModules: 10
          }
        ])
      )
    ).toThrow(LabelRenderError)
  })

  it('refuses an element that runs past the bottom of the page', () => {
    expect(() =>
      assertLayoutFitsPage(
        layout([textElement({ yMm: 145, lines: ['a', 'b', 'c'], lineHeightMm: 4 })])
      )
    ).toThrow(LabelRenderError)
  })

  it('refuses text with no size, and a barcode whose modules are not whole positive numbers', () => {
    expect(() => assertLayoutFitsPage(layout([textElement({ sizePt: Number.NaN })]))).toThrow(
      LabelRenderError
    )
    for (const modules of [
      [0, 0],
      [1, -1],
      [1.5, 2]
    ]) {
      expect(() =>
        assertLayoutFitsPage(
          layout([
            {
              kind: LabelElementKinds.BARCODE,
              xMm: 5,
              yMm: 5,
              widthMm: 50,
              heightMm: 10,
              modules,
              quietZoneModules: 10
            }
          ])
        )
      ).toThrow(LabelRenderError)
    }
  })

  it('refuses text the font cannot write, and accepts the Latin letters of a Spanish address', () => {
    expect(() => assertLayoutFitsPage(layout([textElement({ lines: ['Niña 😀'] })]))).toThrow(
      LabelRenderError
    )
    expect(isDrawable('Peña, Núñez — Ñandú € “x”')).toBe(true)
    expect(isDrawable('日本')).toBe(false)
  })

  it('accepts an element that fits the page to the edge, and refuses numbers that are not positions or sizes', () => {
    expect(() =>
      assertLayoutFitsPage(
        layout([textElement({ xMm: 60, widthMm: 40, yMm: 146, lines: ['a'], lineHeightMm: 4 })])
      )
    ).not.toThrow()
    const bad: Partial<LabelTextElement>[] = [
      { lineHeightMm: 0 },
      { widthMm: 0 },
      { xMm: Number.NaN },
      { yMm: Number.POSITIVE_INFINITY }
    ]
    for (const over of bad) {
      expect(() => assertLayoutFitsPage(layout([textElement(over)]))).toThrow(LabelRenderError)
    }
  })

  it('refuses a barcode with a negative or fractional quiet zone, or no height', () => {
    const barcode = (over: { quietZoneModules?: number; heightMm?: number }) =>
      layout([
        {
          kind: LabelElementKinds.BARCODE,
          xMm: 5,
          yMm: 5,
          widthMm: 50,
          heightMm: 10,
          modules: [1, 1],
          quietZoneModules: 10,
          ...over
        }
      ])
    for (const over of [{ quietZoneModules: -1 }, { quietZoneModules: 1.5 }, { heightMm: 0 }]) {
      expect(() => assertLayoutFitsPage(barcode(over))).toThrow(LabelRenderError)
    }
    expect(() => assertLayoutFitsPage(barcode({}))).not.toThrow()
  })
})
