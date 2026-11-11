import { formatPhoneList, LabelPageSizesMm } from '@platform/core/domain'
import {
  type LabelElement,
  LabelElementKinds,
  type LabelInput,
  type LabelLayout,
  LabelPaymentKinds
} from '@platform/plugins/sdk'

import { Code128, Code128EncodeError, encodeCode128 } from './code128'

// The label cannot say what it must say: the courier would collect a wrong amount or look for a missing address. The
// caller gets this, never a label with a cut amount or recipient
export class LabelLayoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LabelLayoutError'
  }
}

// The label of the `local` carrier (TDD_17 §4.2) as a layout: where the Code 128 barcode, the guide as text, the
// recipient, the amount to collect or the word for "paid", and the rest go on the page of the connection's format.
// Pure: the same input gives the same layout. The core draws it with the PDF renderer, so the result is stored and
// printed like any carrier label.

// One unit of every size of the page: the page of an A4 sheet is twice the height of a 100x150 roll, and its type
// grows with it
const REFERENCE_WIDTH_MM = 100
const MM_PER_PT = 25.4 / 72
// How wide the widest usual character is, as a share of the type size, for a regular or a bold sans face (wide capitals of Helvetica); wrapping counts on it, so a line is never over the box
const CHAR_WIDTH = { regular: 0.72, bold: 0.78 } as const
// The narrowest module a scanner reads, in millimetres
const MIN_MODULE_MM = 0.19
// What a block that must be whole may shrink to, as a share of its size
const MIN_SHRINK = 0.5
const LINE_HEIGHT = 1.25
const ELLIPSIS = '…'

interface Flow {
  elements: LabelElement[]
  yMm: number
  limitMm: number
}

// Wraps by code points (a character of two code units is never split). `lines` is what fits in `maxLines`;
// `truncated` says that something did not
function wrap(
  text: string,
  maxChars: number,
  maxLines: number
): { lines: string[]; truncated: boolean } {
  if (maxLines <= 0) return { lines: [], truncated: text.trim().length > 0 }
  const lines: string[] = []
  let current = ''
  const length = (value: string): number => [...value].length
  for (const word of text.split(/\s+/).filter(w => w.length > 0)) {
    // A word longer than a line is cut: a long address must not leave the page
    let rest = [...word]
    while (rest.length > maxChars) {
      if (current.length > 0) {
        lines.push(current)
        current = ''
      }
      lines.push(rest.slice(0, maxChars).join(''))
      rest = rest.slice(maxChars)
    }
    const restText = rest.join('')
    const joined = current.length === 0 ? restText : `${current} ${restText}`
    if (length(joined) <= maxChars) {
      current = joined
    } else {
      lines.push(current)
      current = restText
    }
  }
  if (current.length > 0) lines.push(current)
  if (lines.length <= maxLines) return { lines, truncated: false }
  const kept = lines.slice(0, maxLines)
  const last = [...(kept[maxLines - 1] ?? '')]
  kept[maxLines - 1] = `${last.slice(0, Math.max(0, maxChars - 1)).join('')}${ELLIPSIS}`
  return { lines: kept, truncated: true }
}

export function buildLocalLabelLayout(input: LabelInput): LabelLayout {
  const { widthMm, heightMm } = LabelPageSizesMm[input.format]
  const scale = widthMm / REFERENCE_WIDTH_MM
  const marginMm = 4 * scale
  const innerWidthMm = widthMm - 2 * marginMm
  const flow: Flow = { elements: [], yMm: marginMm, limitMm: heightMm - marginMm }

  // A block of text: wrapped to the width and placed, and the flow moves down. What may be lost (the sender, the notes)
  // is cut to the lines left on the page. What must be whole (the guide, the amount, the recipient) shrinks to fit and,
  // if it still does not, the label is refused: a cut amount or address is worse than no label
  const text = (
    value: string,
    sizePt: number,
    options: {
      bold?: boolean
      align?: 'left' | 'center'
      maxLines?: number
      gapMm?: number
      whole?: boolean
    } = {}
  ): void => {
    const bold = options.bold === true
    const whole = options.whole === true
    const maxLines = options.maxLines ?? 4
    const charWidth = bold ? CHAR_WIDTH.bold : CHAR_WIDTH.regular
    let size = sizePt * scale
    for (;;) {
      const lineHeightMm = size * MM_PER_PT * LINE_HEIGHT
      const maxChars = Math.max(1, Math.floor(innerWidthMm / (size * MM_PER_PT * charWidth)))
      const room = Math.floor((flow.limitMm - flow.yMm) / lineHeightMm)
      const { lines, truncated } = wrap(value, maxChars, Math.max(0, Math.min(maxLines, room)))
      if (whole && truncated) {
        if (size * 0.9 < sizePt * scale * MIN_SHRINK) {
          throw new LabelLayoutError('The label cannot hold the text it must print')
        }
        size *= 0.9
        continue
      }
      if (lines.length === 0) return
      flow.elements.push({
        kind: LabelElementKinds.TEXT,
        xMm: marginMm,
        yMm: flow.yMm,
        widthMm: innerWidthMm,
        sizePt: size,
        bold,
        align: options.align ?? 'left',
        lines,
        lineHeightMm
      })
      flow.yMm += lines.length * lineHeightMm + (options.gapMm ?? 0) * scale
      return
    }
  }
  const rule = (): void => {
    flow.elements.push({
      kind: LabelElementKinds.RULE,
      xMm: marginMm,
      yMm: flow.yMm,
      widthMm: innerWidthMm
    })
    flow.yMm += 2 * scale
  }

  const { sender, recipient, texts } = input

  // The sender, small: the courier needs it only to take a package back
  text(
    [
      `${texts.from}: ${sender.name}`,
      ...(sender.phone === undefined ? [] : [sender.phone]),
      ...sender.addressLines
    ].join(', '),
    7,
    { maxLines: 2, gapMm: 1.5 }
  )
  rule()

  // The barcode, with its quiet zone inside the width, and the guide as text under it
  const modules = encodeGuide(input.guideNumber)
  const symbolModules =
    modules.reduce((total, width) => total + width, 0) + 2 * Code128.QUIET_ZONE_MODULES
  if (innerWidthMm / symbolModules < MIN_MODULE_MM) {
    throw new LabelLayoutError('The guide is too long to draw as a barcode a scanner can read')
  }
  const barcodeHeightMm = 22 * scale
  flow.elements.push({
    kind: LabelElementKinds.BARCODE,
    xMm: marginMm,
    yMm: flow.yMm,
    widthMm: innerWidthMm,
    heightMm: barcodeHeightMm,
    modules,
    quietZoneModules: Code128.QUIET_ZONE_MODULES
  })
  flow.yMm += barcodeHeightMm + 1 * scale
  text(input.guideNumber, 13, { bold: true, align: 'center', maxLines: 1, gapMm: 1.5, whole: true })
  rule()

  // What the courier collects, in large type, or the word for "paid"
  if (input.payment.kind === LabelPaymentKinds.COD) {
    text(texts.collect, 8, { align: 'center', maxLines: 1 })
    text(input.payment.amountText, 30, {
      bold: true,
      align: 'center',
      maxLines: 1,
      gapMm: 1.5,
      whole: true
    })
  } else {
    text(texts.paid, 30, { bold: true, align: 'center', maxLines: 1, gapMm: 1.5, whole: true })
  }
  rule()

  // The recipient: name, every phone, full address
  text(texts.to, 8, { maxLines: 1 })
  text(recipient.name, 15, { bold: true, maxLines: 2, whole: true })
  text(formatPhoneList(recipient.phones), 12, { bold: true, maxLines: 3, whole: true })
  text(recipient.addressLines.join(', '), 11, { maxLines: 8, gapMm: 1.5, whole: true })
  rule()

  // The rest, from the least to the most expendable: the notes are what gives way when the page is full
  text(`${texts.order}: ${input.orderNumber}`, 9, { maxLines: 1 })
  text(`${texts.packages}: ${input.packageCount}`, 9, { maxLines: 1 })
  text(`${texts.service}: ${input.serviceLabel}`, 9, { maxLines: 1 })
  if (input.notes !== undefined && input.notes.trim().length > 0) {
    text(`${texts.notes}: ${input.notes}`, 8, { maxLines: 4 })
  }

  // The flow limit holds for the text that gives way; the barcode and the rules are placed whatever is left
  if (flow.yMm > flow.limitMm + 0.01) {
    throw new LabelLayoutError('The label does not fit its page')
  }
  return { format: input.format, widthMm, heightMm, elements: flow.elements }
}

// The guide is the one thing a scanner reads: what Code 128 cannot hold is refused with the error of the label
function encodeGuide(guideNumber: string): number[] {
  try {
    return encodeCode128(guideNumber)
  } catch (error) {
    if (error instanceof Code128EncodeError) {
      throw new LabelLayoutError('The guide number cannot be drawn as a barcode')
    }
    throw error
  }
}
