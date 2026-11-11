import PDFDocument from 'pdfkit'
import { createElement, type ReactElement } from 'react'

import { LabelElementKinds, type LabelLayout } from '@platform/plugins/sdk'

import {
  assertLayoutFitsPage,
  fitLine,
  LabelRenderError,
  MM_TO_PT,
  type TextMeter
} from './label-fit'

// The two faces of the standard fonts every PDF reader has, so that nothing is embedded and the width of a line is the
// one the reader will draw
const FONT_REGULAR = 'Helvetica'
const FONT_BOLD = 'Helvetica-Bold'
const INK = '#000000'
// A rule is a line a third of a millimetre thick
const RULE_THICKNESS_MM = 0.35

// Measures with the font metrics of the standard faces, the same ones the renderer lays the text out with
export function createLabelMeter(): TextMeter {
  const document = new PDFDocument({ autoFirstPage: false })
  return (text, sizePt, bold) =>
    document
      .font(bold ? FONT_BOLD : FONT_REGULAR)
      .fontSize(sizePt)
      .widthOfString(text)
}

const pt = (mm: number): number => mm * MM_TO_PT

// Draws the layout of an internal carrier on a PDF page of its own size and returns the file. Pure but for the renderer:
// the same layout draws the same page (the file itself carries the date it was made). Throws LabelRenderError for a label it cannot draw whole.
export async function renderLabelPdf(layout: LabelLayout): Promise<Uint8Array> {
  assertLayoutFitsPage(layout)
  const meter = createLabelMeter()
  // The package is ESM only, and it is loaded the first time a label is drawn
  const pdf = await import('@react-pdf/renderer')

  const children: ReactElement[] = []
  let key = 0
  for (const element of layout.elements) {
    if (element.kind === LabelElementKinds.TEXT) {
      element.lines.forEach((line, index) => {
        const fitted = fitLine(element, line, meter)
        children.push(
          createElement(
            pdf.Text,
            {
              key: key++,
              wrap: false,
              style: {
                position: 'absolute',
                left: pt(element.xMm),
                top: pt(element.yMm + index * element.lineHeightMm),
                width: pt(element.widthMm),
                fontFamily: element.bold ? FONT_BOLD : FONT_REGULAR,
                fontSize: fitted.sizePt,
                textAlign: element.align,
                color: INK
              }
            },
            fitted.text
          )
        )
      })
    } else if (element.kind === LabelElementKinds.RULE) {
      children.push(
        createElement(pdf.View, {
          key: key++,
          style: {
            position: 'absolute',
            left: pt(element.xMm),
            top: pt(element.yMm),
            width: pt(element.widthMm),
            height: pt(RULE_THICKNESS_MM),
            backgroundColor: INK
          }
        })
      )
    } else {
      // Bars and spaces alternate, starting with a bar, between two quiet zones of empty modules
      const totalModules =
        element.modules.reduce((sum, modules) => sum + modules, 0) + 2 * element.quietZoneModules
      const modulePt = pt(element.widthMm) / totalModules
      let cursor = element.quietZoneModules
      element.modules.forEach((modules, index) => {
        if (index % 2 === 0) {
          children.push(
            createElement(pdf.View, {
              key: key++,
              style: {
                position: 'absolute',
                left: pt(element.xMm) + cursor * modulePt,
                top: pt(element.yMm),
                width: modules * modulePt,
                height: pt(element.heightMm),
                backgroundColor: INK
              }
            })
          )
        }
        cursor += modules
      })
    }
  }

  const page = createElement(
    pdf.Page,
    { size: [pt(layout.widthMm), pt(layout.heightMm)], style: { backgroundColor: '#ffffff' } },
    ...children
  )
  const buffer = await pdf.renderToBuffer(createElement(pdf.Document, null, page))
  if (buffer.byteLength === 0) throw new LabelRenderError('the renderer made an empty file')
  return new Uint8Array(buffer)
}
