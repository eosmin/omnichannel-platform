import { LabelElementKinds, type LabelLayout, type LabelTextElement } from '@platform/plugins/sdk'

// The label of an internal carrier is drawn as the plugin laid it out, with one correction the plugin cannot make: it
// wraps with a safe estimate of the glyph widths, and a font can still beat it (a run of W or M). A line the real font
// measures wider than its box is drawn smaller, and a label that would need type too small to read is refused, never
// printed with a cut amount or a cut address (TDD_17 §4.2).

// The smallest type a courier can read on a thermal label, in points
export const MIN_LABEL_FONT_PT = 5

export class LabelRenderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LabelRenderError'
  }
}

export const MM_TO_PT = 72 / 25.4

// The width in points of a text at a size, in the regular or the bold face of the font the label is drawn with
export type TextMeter = (text: string, sizePt: number, bold: boolean) => number

export interface FittedLine {
  text: string
  sizePt: number
}

// One line of a text element, at the type size it needs to fit the width of its box
export function fitLine(element: LabelTextElement, text: string, meter: TextMeter): FittedLine {
  const boxPt = element.widthMm * MM_TO_PT
  const wanted = meter(text, element.sizePt, element.bold)
  if (wanted <= boxPt) return { text, sizePt: element.sizePt }
  // Linear in the size, rounded down to a tenth of a point so that the rounding never makes it wider
  const sizePt = Math.floor(((element.sizePt * boxPt) / wanted) * 10) / 10
  if (sizePt < MIN_LABEL_FONT_PT) {
    throw new LabelRenderError('a line of the label does not fit its box at a readable size')
  }
  return { text, sizePt }
}

// What the standard fonts the label is drawn with can write: Latin-1 and the extra characters of Windows-1252. Anything else
// would print a wrong glyph or none, so the label is refused instead (a font that covers more is Step 7.7)
const CP1252_EXTRAS = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ')
export function isDrawable(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    const printable = (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)
    if (!printable && !CP1252_EXTRAS.has(char)) return false
  }
  return true
}

const finitePositive = (value: number): boolean => Number.isFinite(value) && value > 0

// A layout the page cannot hold: an element outside it (in either direction), numbers that are not sizes, a barcode with
// no bars, or a character the font cannot write, is the plugin's bug or the data's and is refused before anything is drawn
export function assertLayoutFitsPage(layout: LabelLayout): void {
  if (!(finitePositive(layout.widthMm) && finitePositive(layout.heightMm))) {
    throw new LabelRenderError('the label has no page')
  }
  for (const element of layout.elements) {
    if (
      !(Number.isFinite(element.xMm) && Number.isFinite(element.yMm)) ||
      element.xMm < 0 ||
      element.yMm < 0 ||
      !finitePositive(element.widthMm) ||
      element.xMm + element.widthMm > layout.widthMm + 1e-6
    ) {
      throw new LabelRenderError('an element of the label is outside its page')
    }
    let bottomMm = element.yMm
    if (element.kind === LabelElementKinds.TEXT) {
      if (!finitePositive(element.sizePt) || !finitePositive(element.lineHeightMm)) {
        throw new LabelRenderError('a text of the label has no size')
      }
      if (!element.lines.every(isDrawable)) {
        throw new LabelRenderError('a text of the label has a character the font cannot write')
      }
      bottomMm += element.lines.length * element.lineHeightMm
    } else if (element.kind === LabelElementKinds.BARCODE) {
      const sum = element.modules.reduce((total, modules) => total + modules, 0)
      if (
        element.modules.length === 0 ||
        !element.modules.every(modules => Number.isInteger(modules) && modules > 0) ||
        !Number.isInteger(element.quietZoneModules) ||
        element.quietZoneModules < 0 ||
        !(sum > 0) ||
        !finitePositive(element.heightMm)
      ) {
        throw new LabelRenderError('the barcode of the label has no bars')
      }
      bottomMm += element.heightMm
    }
    if (bottomMm > layout.heightMm + 1e-6) {
      throw new LabelRenderError('an element of the label runs past the bottom of its page')
    }
  }
}
