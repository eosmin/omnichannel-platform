import type { LabelFormatType } from '@platform/core/domain'

// The label of a carrier that has no label of its own (the `local` carrier, TDD_17 §4.2), as plain data.
// The plugin decides what the label says and where; the core draws it on a PDF page of the connection's format.
// Everything here is already localized: the core passes the texts and the amount in the store's language, the
// plugin only places them, so no carrier writes a user-facing string of its own.

export interface LabelTexts {
  from: string
  to: string
  // The caption above the amount the courier collects
  collect: string
  // What a prepaid shipment prints in the place of an amount
  paid: string
  order: string
  packages: string
  service: string
  notes: string
}

export const LabelPaymentKinds = { COD: 'cod', PAID: 'paid' } as const
export type LabelPayment =
  | { kind: typeof LabelPaymentKinds.COD; amountText: string }
  | { kind: typeof LabelPaymentKinds.PAID }

export interface LabelParty {
  name: string
  addressLines: readonly string[]
}

export interface LabelInput {
  format: LabelFormatType
  guideNumber: string
  orderNumber: string
  sender: LabelParty & { phone?: string }
  // National digits only; the label prints them all (TDD_17 §4.2)
  recipient: LabelParty & { phones: readonly string[] }
  packageCount: number
  serviceLabel: string
  notes?: string
  payment: LabelPayment
  texts: LabelTexts
}

export const LabelElementKinds = { TEXT: 'text', BARCODE: 'barcode', RULE: 'rule' } as const

export interface LabelTextElement {
  kind: typeof LabelElementKinds.TEXT
  xMm: number
  yMm: number
  widthMm: number
  sizePt: number
  bold: boolean
  align: 'left' | 'center'
  // Already wrapped to the width with a safe estimate of the glyph widths, which a font can still beat (a run of
  // W or M): a renderer draws one line under the other and scales a line it measures wider than `widthMm` down to fit
  lines: readonly string[]
  lineHeightMm: number
}

export interface LabelBarcodeElement {
  kind: typeof LabelElementKinds.BARCODE
  xMm: number
  yMm: number
  widthMm: number
  heightMm: number
  // Alternating bar and space widths in modules, starting with a bar: the symbol, quiet zone excluded
  modules: readonly number[]
  // The empty modules a scanner needs on each side; the width above holds the symbol and both
  quietZoneModules: number
}

export interface LabelRuleElement {
  kind: typeof LabelElementKinds.RULE
  xMm: number
  yMm: number
  widthMm: number
}

export type LabelElement = LabelTextElement | LabelBarcodeElement | LabelRuleElement

export interface LabelLayout {
  format: LabelFormatType
  widthMm: number
  heightMm: number
  elements: readonly LabelElement[]
}
