import { createHash } from 'node:crypto'

import {
  FiscalDocumentKind,
  FiscalEnvironment,
  FiscalOperationCondition,
  FiscalVoidKind,
  PaymentMethod,
  TaxTreatment
} from '@platform/core/domain'
import type {
  BuiltDocument,
  ConformanceStep,
  ConformanceTargets,
  FiscalBuildInput,
  FiscalCreditedDocument,
  FiscalIssuerInput,
  FiscalLine,
  FiscalReceiver,
  FiscalVoidParty
} from '@platform/fiscal/sdk'

import { ACTIVITIES } from '../catalogs/activities'
import { DISTRICTS } from '../catalogs/districts'
import { MUNICIPALITIES } from '../catalogs/municipalities'
import {
  SvAddressKeys,
  SvContingency,
  SvIdentityDocuments,
  SvProviderDataKeys,
  SvVat
} from '../sv-constants'
import { allocate } from '../sv-decimal'
import { SALVADOR_OFFSET_HOURS } from '../sv-time'

// The plan of the minimum tests of the sandbox (Step 4B.7c-6; Funcional §XXIV): 90 invoices, 75 tax credit documents, 50 credit notes, 25
// debit notes, 50 remission notes and 25 invoices of an excluded subject with seal, 5 invalidations and 5 contingencies, made of invented data in many shapes (receivers, tax treatments, discounts, rounding, payments,
// dates inside the term). Pure and deterministic: the same options give the same plan, so a run can be repeated and compared. Nothing here
// is read from the environment and nothing is a real person: the tax numbers and the names are made up.

export interface SvConformanceCounts {
  readonly invoices: number
  readonly taxCredits: number
  readonly creditNotes: number
  readonly debitNotes: number
  readonly remissionNotes: number
  readonly excludedSubjects: number
  readonly voids: number
  readonly contingencies: number
  // Documents each contingency event lists
  readonly deferredPerContingency: number
}

// An issuer made up for a run that sends nothing (the simulator, a dry run): no real tax number, name or contact
export const SvConformanceDemoIssuer: FiscalIssuerInput = {
  legalName: 'Emisor de Prueba S.A. de C.V.',
  taxId: '00000000000001',
  registrationId: '1234567',
  address: {
    [SvAddressKeys.DEPARTMENT]: '06',
    [SvAddressKeys.MUNICIPALITY]: '23',
    [SvAddressKeys.DISTRICT]: '01',
    [SvAddressKeys.COMPLEMENT]: 'Calle de prueba 1'
  },
  activityCode: '47119',
  establishmentCode: 'M001',
  establishmentType: '02',
  pointOfSaleCode: 'P001',
  phone: '22220000',
  email: 'prueba@example.test',
  environment: FiscalEnvironment.SANDBOX
}

// The parts of the minimum the authority asks (the documents made for the invalidations and the contingencies count toward none of them)
export const SvConformanceBuckets = {
  INVOICE: 'invoice',
  TAX_CREDIT: 'tax_credit',
  CREDIT_NOTE: 'credit_note',
  DEBIT_NOTE: 'debit_note',
  REMISSION_NOTE: 'remission_note',
  EXCLUDED_SUBJECT: 'excluded_subject'
} as const

export const SvConformanceLimits = {
  // An invoice to a final consumer who gave no identity is not made for this much or more (the notice of the authority of 2024-09-05 sets
  // the threshold; **[TO CONFIRM IN THE SANDBOX]**): the plan names a receiver for it
  ANONYMOUS_INVOICE_CENTS: 109_500,
  // How far back a document is dated: inside the month of the run, and never more than this before the moment it is sent
  MAX_BACK_MINUTES: 2 * 24 * 60
} as const

export const SvConformanceDefaults: SvConformanceCounts = {
  invoices: 90,
  taxCredits: 75,
  creditNotes: 50,
  // Funcional page 79: the debit note asks for 25
  debitNotes: 25,
  // Funcional page 79: the remission note asks for 50
  remissionNotes: 50,
  // Funcional: the invoice of an excluded subject asks for 25
  excludedSubjects: 25,
  voids: 5,
  contingencies: 5,
  deferredPerContingency: 2
}

export interface SvConformanceOptions {
  readonly issuer: FiscalIssuerInput
  // Told apart from another run: the generation code of each document is derived from it, so a second run is not a duplicate of the first
  readonly batch: string
  readonly seed: number
  readonly now: Date
  readonly counts?: Partial<SvConformanceCounts>
  // The numbers of the series start after this many: a second run continues where the first stopped
  readonly correlativeOffset?: number
  // Who answers for the establishment in the events of contingency and who makes and asks the invalidations
  readonly responsible?: FiscalVoidParty
}

// A generator of numbers from a seed (mulberry32): the plan never uses the clock or the system's randomness
function generator(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const roundDiv = (numerator: number, denominator: number): number =>
  Math.floor((2 * numerator + denominator) / (2 * denominator))

const MINUTES_PER_HOUR = 60
const MINUTE_MS = 60_000

// The generation code of a document: derived from the batch and the id of the step, in the shape of a random UUID
function uuidOf(batch: string, id: string): string {
  const hex = createHash('sha256').update(`${batch}:${id}`).digest('hex')
  const variant = ((Number.parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

const GOODS = [
  'Camisa de algodón',
  'Pantalón de tela',
  'Zapatos de cuero',
  'Mochila escolar',
  'Cuaderno profesional',
  'Lámpara de escritorio',
  'Audífonos',
  'Botella térmica',
  'Gorra deportiva',
  'Cargador USB'
]
const SERVICES = ['Instalación', 'Asesoría técnica', 'Mantenimiento', 'Capacitación']
const COMPANIES = [
  'Distribuidora Cuscatlán',
  'Comercial Volcán',
  'Servicios Lempa',
  'Importadora Izalco',
  'Ferretería Torogoz',
  'Papelería Cuzcatlán'
]
const FIRST = ['Ana', 'Luis', 'María', 'José', 'Carmen', 'Carlos', 'Rosa', 'Miguel']
const LAST = ['Pérez', 'Gómez', 'Martínez', 'Hernández', 'López', 'Ramos', 'Flores', 'Rivas']
const UNITS = ['59', '59', '59', '1', '2']
const METHODS = [PaymentMethod.CASH, PaymentMethod.CARD, PaymentMethod.TRANSFER]

interface Rng {
  next(): number
  int(min: number, max: number): number
  pick<T>(items: readonly T[]): T
  chance(probability: number): boolean
  digits(length: number): string
}

function rngOf(seed: number): Rng {
  const next = generator(seed)
  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1))
  return {
    next,
    int,
    pick: items => items[int(0, items.length - 1)] as (typeof items)[number],
    chance: probability => next() < probability,
    digits: length => Array.from({ length }, () => int(0, 9)).join('')
  }
}

// ---------------------------------------------------------------- receivers

const places = MUNICIPALITIES.filter(row => row.department !== '00')
const districts = DISTRICTS.filter(row => row.code !== '00')

function addressOf(rng: Rng): Record<string, string> {
  const place = rng.pick(places)
  return {
    [SvAddressKeys.DEPARTMENT]: place.department,
    [SvAddressKeys.MUNICIPALITY]: place.code,
    [SvAddressKeys.DISTRICT]: rng.pick(districts).code,
    [SvAddressKeys.COMPLEMENT]: `Calle ${rng.int(1, 99)}, casa ${rng.int(1, 300)}`
  }
}

const personName = (rng: Rng): string => `${rng.pick(FIRST)} ${rng.pick(LAST)} ${rng.pick(LAST)}`
// Invented numbers: a tax number begins with four zeros, which no taxpayer has
const fakeTaxNumber = (rng: Rng): string => `0000${rng.digits(10)}`
const fakeNationalId = (rng: Rng): string => `0${rng.digits(8)}`
// A national id that passes the check digit a person's entry is held to (a remission note is refused with one that does not): seven invented
// digits after a zero, and the digit that completes them
const nationalIdWithCheckDigit = (rng: Rng): string => {
  const body = `0${rng.digits(7)}`
  const weights = [9, 8, 7, 6, 5, 4, 3, 2]
  const sum = weights.reduce((total, weight, index) => total + weight * Number(body[index]), 0)
  return `${body}${(10 - (sum % 10)) % 10}`
}
const contact = (rng: Rng, name: string): Pick<FiscalReceiver, 'email' | 'phone'> => ({
  email: `${name.split(' ')[0]?.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '') ?? 'cliente'}${rng.int(1, 999)}@example.test`,
  phone: `7${rng.digits(7)}`
})

const NO_RECEIVER: FiscalReceiver = {
  name: null,
  taxId: null,
  registrationId: null,
  address: null,
  email: null,
  phone: null,
  taxpayerType: null,
  economicActivity: null,
  documentType: null
}

function consumerOf(rng: Rng): { receiver: FiscalReceiver; tags: string[] } {
  const roll = rng.next()
  if (roll < 0.4) return { receiver: NO_RECEIVER, tags: ['consumer_anonymous'] }
  const name = personName(rng)
  if (roll < 0.7) {
    return {
      receiver: {
        ...NO_RECEIVER,
        name,
        taxId: fakeNationalId(rng),
        documentType: SvIdentityDocuments.NATIONAL_ID,
        ...(rng.chance(0.5) ? contact(rng, name) : {})
      },
      tags: ['consumer_national_id']
    }
  }
  return {
    receiver: {
      ...NO_RECEIVER,
      name,
      taxId: fakeTaxNumber(rng),
      documentType: SvIdentityDocuments.TAX_ID,
      ...contact(rng, name)
    },
    tags: ['consumer_tax_number', 'with_contact']
  }
}

// The person (or the company) a remission note sends the goods to: any identity document, the activity and the address the schema asks for;
// a registration number only when it is a company
function recipientOf(rng: Rng): { receiver: FiscalReceiver; tags: string[] } {
  if (rng.chance(0.4)) return { receiver: businessOf(rng), tags: ['recipient_company'] }
  const name = personName(rng)
  const national = rng.chance(0.6)
  return {
    receiver: {
      ...NO_RECEIVER,
      name,
      taxId: national ? nationalIdWithCheckDigit(rng) : fakeTaxNumber(rng),
      documentType: national ? SvIdentityDocuments.NATIONAL_ID : SvIdentityDocuments.TAX_ID,
      address: addressOf(rng),
      economicActivity: rng.pick(ACTIVITIES).code,
      ...contact(rng, name)
    },
    tags: [national ? 'recipient_national_id' : 'recipient_tax_number']
  }
}

// The seller of an invoice of an excluded subject: a person with a national id, another document or a tax number, with an address (invented)
function sellerOf(rng: Rng): { receiver: FiscalReceiver; tags: string[] } {
  const name = personName(rng)
  const roll = rng.next()
  const identity =
    roll < 0.5
      ? {
          taxId: nationalIdWithCheckDigit(rng),
          documentType: SvIdentityDocuments.NATIONAL_ID,
          tag: 'seller_national_id'
        }
      : roll < 0.8
        ? {
            taxId: fakeTaxNumber(rng),
            documentType: SvIdentityDocuments.TAX_ID,
            tag: 'seller_tax_number'
          }
        : {
            taxId: `P${rng.digits(8)}`,
            documentType: SvIdentityDocuments.OTHER,
            tag: 'seller_other_document'
          }
  return {
    receiver: {
      ...NO_RECEIVER,
      name,
      taxId: identity.taxId,
      documentType: identity.documentType,
      address: addressOf(rng),
      ...(rng.chance(0.5) ? contact(rng, name) : {})
    },
    tags: [identity.tag]
  }
}

function businessOf(rng: Rng): FiscalReceiver {
  const name = `${rng.pick(COMPANIES)} S.A. de C.V.`
  return {
    name,
    taxId: fakeTaxNumber(rng),
    registrationId: rng.digits(rng.int(2, 7)).replace(/^0/, '1'),
    address: addressOf(rng),
    ...contact(rng, name),
    taxpayerType: null,
    economicActivity: rng.pick(ACTIVITIES).code,
    documentType: null
  }
}

// ---------------------------------------------------------------- amounts

interface LineSpec {
  readonly description: string
  readonly quantity: number
  // As the order has it: with the tax inside when the prices include it
  readonly unitPriceCents: number
  readonly treatment: TaxTreatment
  readonly service: boolean
  readonly unit: string
}

interface Composition {
  readonly lines: readonly FiscalLine[]
  readonly shippingCents: number
  readonly shippingTaxCents: number
  readonly discountCents: number
  readonly taxCents: number
  readonly totalCents: number
}

// The figures of a sale from its parts, the way the authority reads them: the discount of the order is split over the lines by their value,
// the tax of the whole taxed part is the one of the authority's formula (inside the prices: sales / 1.13 x 13 %; apart: sales x 13 %) and
// is split over the taxed items. So the document always adds up to the cent and the tax is exactly the formula's.
function compose(
  specs: readonly LineSpec[],
  shippingCents: number,
  shippingTaxed: boolean,
  discountCents: number,
  pricesIncludeTax: boolean
): Composition {
  const gross = specs.map(spec => spec.quantity * spec.unitPriceCents)
  const discounts = allocate(discountCents, gross)
  const paid = gross.map((value, index) => value - (discounts[index] ?? 0))
  const taxedWeights: number[] = []
  const taxedIndexes: number[] = []
  specs.forEach((spec, index) => {
    if (spec.treatment === TaxTreatment.TAXED) {
      taxedWeights.push(paid[index] ?? 0)
      taxedIndexes.push(index)
    }
  })
  const shippingIndex = shippingTaxed && shippingCents > 0 ? taxedIndexes.length : -1
  if (shippingIndex >= 0) taxedWeights.push(shippingCents)
  const taxedPaid = taxedWeights.reduce((sum, value) => sum + value, 0)
  const tax =
    taxedPaid === 0
      ? 0
      : pricesIncludeTax
        ? roundDiv(taxedPaid * (SvVat.RATE_BPS / 100), 100 + SvVat.RATE_BPS / 100)
        : roundDiv(taxedPaid * SvVat.RATE_BPS, 10_000)
  const shares =
    taxedWeights.length === 0 || tax === 0 ? taxedWeights.map(() => 0) : allocate(tax, taxedWeights)
  const lineTax = new Map<number, number>()
  taxedIndexes.forEach((lineIndex, position) => lineTax.set(lineIndex, shares[position] ?? 0))
  const lines: FiscalLine[] = specs.map((spec, index) => ({
    description: spec.description,
    quantity: spec.quantity,
    unitPriceCents: spec.unitPriceCents,
    taxRateBps: spec.treatment === TaxTreatment.TAXED ? SvVat.RATE_BPS : null,
    taxCents: lineTax.get(index) ?? 0,
    totalCents: gross[index] ?? 0,
    taxTreatment: spec.treatment,
    itemKind: spec.service ? '2' : '1',
    unit: spec.unit
  }))
  const shippingTax = shippingIndex >= 0 ? (shares[shippingIndex] ?? 0) : 0
  const grossTotal = gross.reduce((sum, value) => sum + value, 0)
  return {
    lines,
    shippingCents,
    shippingTaxCents: shippingTax,
    discountCents,
    taxCents: tax,
    totalCents: grossTotal - discountCents + shippingCents + (pricesIncludeTax ? 0 : tax)
  }
}

// What the lines of a sale are: from one to many, in several treatments, with prices that round
function specsOf(rng: Rng, shape: 'plain' | 'mixed' | 'rounding' | 'many'): LineSpec[] {
  const count =
    shape === 'many' ? rng.int(8, 15) : shape === 'plain' ? rng.int(1, 3) : rng.int(2, 5)
  return Array.from({ length: count }, (_, index) => {
    const service = rng.chance(0.2)
    const treatment =
      shape === 'mixed' && index === 1
        ? TaxTreatment.EXEMPT
        : shape === 'mixed' && index === 2
          ? TaxTreatment.NOT_SUBJECT
          : TaxTreatment.TAXED
    return {
      description: service ? rng.pick(SERVICES) : rng.pick(GOODS),
      quantity: shape === 'rounding' ? rng.int(3, 9) : rng.int(1, 5),
      // A price with an odd cent, a third of a dollar or a single cent are what makes the roundings differ
      unitPriceCents:
        shape === 'rounding'
          ? rng.pick([1, 33, 333, 1667, 3333, 999, 10_001])
          : rng.int(150, 12_999),
      treatment,
      service,
      unit: rng.pick(UNITS)
    }
  })
}

function paymentOf(rng: Rng, total: number): Pick<FiscalBuildInput, 'payments' | 'condition'> {
  const method = rng.pick(METHODS)
  return {
    payments: [
      {
        method,
        amountCents: total,
        reference: method === PaymentMethod.TRANSFER ? `TRF-${rng.digits(8)}` : null
      }
    ],
    condition: FiscalOperationCondition.IMMEDIATE
  }
}

// ---------------------------------------------------------------- the plan

export function planSvConformance(options: SvConformanceOptions): ConformanceStep[] {
  const counts = { ...SvConformanceDefaults, ...options.counts }
  const rng = rngOf(options.seed)
  const steps: ConformanceStep[] = []
  const offset = options.correlativeOffset ?? 0
  const series = {
    invoice: offset,
    taxCredit: offset,
    creditNote: offset,
    debitNote: offset,
    remissionNote: offset,
    excludedSubject: offset
  }
  let sequence = offset
  const nowMs = options.now.getTime()
  // The month is the one of El Salvador (UTC-6), where a document is dated: the first instant of it, as an instant
  const local = new Date(nowMs - SALVADOR_OFFSET_HOURS * 60 * MINUTE_MS)
  const monthStart =
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) +
    SALVADOR_OFFSET_HOURS * 60 * MINUTE_MS
  // A document is dated inside the term: a date before the moment it is sent and in the month of the run
  const issuedAt = (maxBackMinutes: number, notBefore: number = monthStart): string => {
    // At least a minute before the moment it is sent, no further back than the term, the month of the run, or the document it follows
    const room = Math.floor((nowMs - Math.max(monthStart, notBefore)) / MINUTE_MS) - 1
    const farthest = Math.max(1, Math.min(maxBackMinutes, room))
    return new Date(nowMs - rng.int(Math.min(5, farthest), farthest) * MINUTE_MS).toISOString()
  }
  const base = (
    id: string,
    type: 'invoice' | 'taxCredit' | 'creditNote' | 'debitNote' | 'remissionNote' | 'excludedSubject'
  ): Pick<
    FiscalBuildInput,
    'sequenceNumber' | 'correlative' | 'documentUuid' | 'orderNumber' | 'currency' | 'issuer'
  > => {
    series[type] += 1
    sequence += 1
    return {
      sequenceNumber: sequence,
      correlative: series[type],
      documentUuid: uuidOf(options.batch, id),
      orderNumber: `CONF-${options.batch}-${id}`,
      currency: 'USD',
      issuer: options.issuer
    }
  }
  const shapes = ['plain', 'mixed', 'rounding', 'many'] as const

  const invoiceInput = (
    id: string,
    when: string,
    contingency?: FiscalBuildInput['contingency']
  ) => {
    const shape = shapes[steps.length % shapes.length] as (typeof shapes)[number]
    const consumer = consumerOf(rng)
    let receiver = consumer.receiver
    let tags = consumer.tags
    const specs = specsOf(rng, shape)
    const shipping = rng.chance(0.4) ? rng.int(300, 1500) : 0
    const shippingTaxed = shipping > 0 && rng.chance(0.6)
    const gross = specs.reduce((sum, spec) => sum + spec.quantity * spec.unitPriceCents, 0)
    const discount = rng.chance(0.35) ? roundDiv(gross * rng.int(1, 20), 100) : 0
    const sale = compose(specs, shipping, shippingTaxed, discount, true)
    // A big sale to nobody is not made: the plan gives it a receiver
    if (receiver.taxId === null && sale.totalCents >= SvConformanceLimits.ANONYMOUS_INVOICE_CENTS) {
      receiver = {
        ...NO_RECEIVER,
        name: personName(rng),
        taxId: fakeNationalId(rng),
        documentType: SvIdentityDocuments.NATIONAL_ID
      }
      tags = ['consumer_national_id']
    }
    const input: FiscalBuildInput = {
      kind: FiscalDocumentKind.SALE,
      credited: null,
      ...base(id, 'invoice'),
      issuedAt: when,
      receiver,
      lines: sale.lines,
      shippingCents: sale.shippingCents,
      shippingTaxCents: sale.shippingTaxCents,
      discountCents: sale.discountCents,
      totalCents: sale.totalCents,
      taxCents: sale.taxCents,
      pricesIncludeTax: true,
      ...paymentOf(rng, sale.totalCents),
      ...(contingency === undefined ? {} : { contingency })
    }
    const labels = [
      ...tags,
      shape,
      ...(discount > 0 ? ['discount'] : []),
      ...(shipping > 0 ? [shippingTaxed ? 'shipping_taxed' : 'shipping_exempt'] : [])
    ]
    return { input, tags: labels }
  }

  // The invoices
  for (let n = 1; n <= counts.invoices; n += 1) {
    const id = `INV-${String(n).padStart(3, '0')}`
    const made = invoiceInput(id, issuedAt(SvConformanceLimits.MAX_BACK_MINUTES))
    steps.push({
      kind: 'sale',
      id,
      tags: ['invoice', ...made.tags],
      bucket: SvConformanceBuckets.INVOICE,
      input: made.input
    })
  }

  // The tax credit documents, and what each one holds, for the credit notes
  const taxCredits: {
    id: string
    input: FiscalBuildInput
    specs: LineSpec[]
    includes: boolean
    discount: number
    gross: number
  }[] = []
  for (let n = 1; n <= counts.taxCredits; n += 1) {
    const id = `CCF-${String(n).padStart(3, '0')}`
    const shape = shapes[n % shapes.length] as (typeof shapes)[number]
    const specs = specsOf(rng, shape)
    const includes = rng.chance(0.25)
    const shipping = rng.chance(0.3) ? rng.int(300, 1500) : 0
    const shippingTaxed = shipping > 0 && rng.chance(0.7)
    const gross = specs.reduce((sum, spec) => sum + spec.quantity * spec.unitPriceCents, 0)
    const discount = rng.chance(0.3) ? roundDiv(gross * rng.int(1, 15), 100) : 0
    const sale = compose(specs, shipping, shippingTaxed, discount, includes)
    const credit = rng.chance(0.3)
    const input: FiscalBuildInput = {
      kind: FiscalDocumentKind.SALE,
      credited: null,
      ...base(id, 'taxCredit'),
      issuedAt: issuedAt(SvConformanceLimits.MAX_BACK_MINUTES),
      receiver: businessOf(rng),
      lines: sale.lines,
      shippingCents: sale.shippingCents,
      shippingTaxCents: sale.shippingTaxCents,
      discountCents: sale.discountCents,
      totalCents: sale.totalCents,
      taxCents: sale.taxCents,
      pricesIncludeTax: includes,
      ...paymentOf(rng, sale.totalCents),
      ...(credit ? { condition: FiscalOperationCondition.DEFERRED } : {})
    }
    taxCredits.push({ id, input, specs, includes, discount: sale.discountCents, gross })
    steps.push({
      kind: 'sale',
      id,
      bucket: SvConformanceBuckets.TAX_CREDIT,
      tags: [
        'tax_credit',
        shape,
        includes ? 'prices_with_tax' : 'prices_net',
        ...(credit ? ['credit_term'] : []),
        ...(discount > 0 ? ['discount'] : []),
        ...(shipping > 0 ? [shippingTaxed ? 'shipping_taxed' : 'shipping_exempt'] : [])
      ],
      input
    })
  }

  // The credit notes: of the first tax credit documents, one note for each, whole or partial
  for (let n = 1; n <= Math.min(counts.creditNotes, taxCredits.length); n += 1) {
    const parent = taxCredits[n - 1]
    if (parent === undefined) break
    const id = `NC-${String(n).padStart(3, '0')}`
    const whole = rng.chance(0.35)
    const returned = parent.specs
      .map(spec => ({
        ...spec,
        quantity: whole ? spec.quantity : rng.int(0, spec.quantity)
      }))
      .filter(spec => spec.quantity > 0)
    // A note with nothing in it is no note: at least one unit of the first line comes back
    const specs: LineSpec[] =
      returned.length > 0
        ? returned
        : parent.specs.slice(0, 1).map(spec => ({ ...spec, quantity: 1 }))
    // The note gives back the discount the units had: the same share of the discount of the document as of its value, so the note is never for
    // more than what the document charged for those units
    const returnedGross = specs.reduce((sum, spec) => sum + spec.quantity * spec.unitPriceCents, 0)
    const discount =
      parent.discount === 0 || parent.gross === 0
        ? 0
        : Math.min(returnedGross, roundDiv(parent.discount * returnedGross, parent.gross))
    const sale = compose(specs, 0, false, discount, parent.includes)
    steps.push({
      kind: 'credit_note',
      id,
      bucket: SvConformanceBuckets.CREDIT_NOTE,
      parent: parent.id,
      tags: ['credit_note', whole ? 'whole_return' : 'partial_return'],
      input: {
        kind: FiscalDocumentKind.CREDIT_NOTE,
        credited: null,
        ...base(id, 'creditNote'),
        // After the document it credits: a note never predates its parent
        issuedAt: issuedAt(SvConformanceLimits.MAX_BACK_MINUTES, Date.parse(parent.input.issuedAt)),
        receiver: parent.input.receiver,
        lines: sale.lines,
        shippingCents: 0,
        shippingTaxCents: 0,
        discountCents: sale.discountCents,
        totalCents: sale.totalCents,
        taxCents: sale.taxCents,
        pricesIncludeTax: parent.includes,
        ...paymentOf(rng, sale.totalCents)
      }
    })
  }

  // The invalidations: documents made for it (the ones of the minimum are never touched), and for a correction or another reason, the
  // document that takes the place of the invalidated one, accepted first (the authority asks for it first)
  const person = (idType: string, digits: string): FiscalVoidParty => ({
    name: personName(rng),
    idType,
    idNumber: digits
  })
  const responsible =
    options.responsible ?? person(SvIdentityDocuments.NATIONAL_ID, fakeNationalId(rng))
  const kinds = [
    FiscalVoidKind.RESCISSION,
    FiscalVoidKind.CORRECTION,
    FiscalVoidKind.RESCISSION,
    FiscalVoidKind.OTHER,
    FiscalVoidKind.CORRECTION
  ]
  for (let n = 1; n <= counts.voids; n += 1) {
    const kind = kinds[(n - 1) % kinds.length] as FiscalVoidKind
    const targetId = `VOID-TARGET-${n}`
    const target = invoiceInput(targetId, issuedAt(24 * MINUTES_PER_HOUR))
    steps.push({
      kind: 'sale',
      id: targetId,
      tags: ['invoice', 'void_target'],
      bucket: null,
      input: target.input
    })
    let replacement: string | null = null
    if (kind !== FiscalVoidKind.RESCISSION) {
      replacement = `VOID-REPLACEMENT-${n}`
      const made = invoiceInput(replacement, issuedAt(24 * MINUTES_PER_HOUR))
      steps.push({
        kind: 'sale',
        id: replacement,
        tags: ['invoice', 'void_replacement'],
        bucket: null,
        input: made.input
      })
    }
    steps.push({
      kind: 'void',
      id: `VOID-${n}`,
      tags: [`void_${kind}`],
      target: targetId,
      reason:
        kind === FiscalVoidKind.RESCISSION
          ? 'Operación cancelada por el cliente'
          : 'Datos del documento incorrectos',
      details: {
        kind,
        responsible,
        requester: person(SvIdentityDocuments.TAX_ID, fakeTaxNumber(rng))
      },
      replacement
    })
  }

  // The contingencies: each lists some deferred documents made inside its window, with a reason of the catalog in turn; the last one that is
  // "other" carries words of its own
  const reasons = Object.values(SvContingency.REASONS)
  for (let n = 1; n <= counts.contingencies; n += 1) {
    const reason = reasons[(n - 1) % reasons.length] as number
    const motive =
      reason === SvContingency.REASONS.OTHER
        ? 'Falla del enlace con el proveedor de servicios'
        : null
    // Each event has a window of its own, after the one before it and before the moment of the run: no two overlap
    const endedAt = new Date(nowMs - (10 + (n - 1) * 40) * MINUTE_MS)
    const startedAt = new Date(endedAt.getTime() - 30 * MINUTE_MS)
    const documents: string[] = []
    for (let k = 1; k <= counts.deferredPerContingency; k += 1) {
      const id = `DEF-${n}-${k}`
      const when = new Date(startedAt.getTime() + rng.int(1, 28) * MINUTE_MS).toISOString()
      const made = invoiceInput(id, when, { reason: String(reason), motive })
      steps.push({
        kind: 'deferred_sale',
        id,
        tags: ['invoice', 'deferred'],
        input: made.input
      })
      documents.push(id)
    }
    steps.push({
      kind: 'contingency',
      id: `CONT-${n}`,
      tags: [`contingency_reason_${reason}`],
      documents,
      event: {
        eventId: uuidOf(options.batch, `CONT-${n}`),
        reason: String(reason),
        motive,
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        responsible
      }
    })
  }
  // The debit notes come last on purpose: they draw from the same seeded generator, and the steps before them (the invalidations and the
  // contingencies) keep the values the same seed gave them before the debit notes existed, so an earlier run can still be compared.
  // The debit notes: of the first tax credit documents, one for each, charging more on some of its lines (a charge never has a discount or
  // shipping of its own). The tax credit documents are shared with the credit notes: a document may be adjusted by both.
  for (let n = 1; n <= Math.min(counts.debitNotes, taxCredits.length); n += 1) {
    const parent = taxCredits[n - 1]
    if (parent === undefined) break
    const id = `ND-${String(n).padStart(3, '0')}`
    const charged = parent.specs
      .map(spec => ({ ...spec, quantity: rng.int(0, spec.quantity) }))
      .filter(spec => spec.quantity > 0)
    // A note with nothing in it is no note: at least one unit of the first line is charged
    const specs: LineSpec[] =
      charged.length > 0
        ? charged
        : parent.specs.slice(0, 1).map(spec => ({ ...spec, quantity: 1 }))
    const sale = compose(specs, 0, false, 0, parent.includes)
    steps.push({
      kind: 'debit_note',
      id,
      bucket: SvConformanceBuckets.DEBIT_NOTE,
      parent: parent.id,
      tags: ['debit_note', parent.includes ? 'prices_with_tax' : 'prices_net'],
      input: {
        kind: FiscalDocumentKind.DEBIT_NOTE,
        credited: null,
        ...base(id, 'debitNote'),
        // After the document it adds to: a note never predates its parent
        issuedAt: issuedAt(SvConformanceLimits.MAX_BACK_MINUTES, Date.parse(parent.input.issuedAt)),
        receiver: parent.input.receiver,
        lines: sale.lines,
        shippingCents: 0,
        shippingTaxCents: 0,
        discountCents: sale.discountCents,
        totalCents: sale.totalCents,
        taxCents: sale.taxCents,
        pricesIncludeTax: parent.includes,
        ...paymentOf(rng, sale.totalCents)
      }
    })
  }

  // The remission notes come after everything else for the same reason: no step before them changes its values. They back goods on their way
  // to a person, before the document of the sale: no document is named and nothing is paid, so each stands alone, with a bucket of its own.
  for (let n = 1; n <= counts.remissionNotes; n += 1) {
    const id = `NR-${String(n).padStart(3, '0')}`
    const shape = shapes[n % shapes.length] as (typeof shapes)[number]
    const specs = specsOf(rng, shape)
    const includes = rng.chance(0.5)
    const shipping = rng.chance(0.3) ? rng.int(300, 1500) : 0
    const shippingTaxed = shipping > 0 && rng.chance(0.7)
    const gross = specs.reduce((sum, spec) => sum + spec.quantity * spec.unitPriceCents, 0)
    const discount = rng.chance(0.25) ? roundDiv(gross * rng.int(1, 15), 100) : 0
    const sale = compose(specs, shipping, shippingTaxed, discount, includes)
    const recipient = recipientOf(rng)
    steps.push({
      kind: 'sale',
      id,
      bucket: SvConformanceBuckets.REMISSION_NOTE,
      tags: [
        'remission_note',
        shape,
        includes ? 'prices_with_tax' : 'prices_net',
        ...recipient.tags,
        ...(discount > 0 ? ['discount'] : []),
        ...(shipping > 0 ? [shippingTaxed ? 'shipping_taxed' : 'shipping_exempt'] : [])
      ],
      input: {
        kind: FiscalDocumentKind.REMISSION_NOTE,
        credited: null,
        ...base(id, 'remissionNote'),
        issuedAt: issuedAt(SvConformanceLimits.MAX_BACK_MINUTES),
        receiver: recipient.receiver,
        lines: sale.lines,
        shippingCents: sale.shippingCents,
        shippingTaxCents: sale.shippingTaxCents,
        discountCents: sale.discountCents,
        totalCents: sale.totalCents,
        taxCents: sale.taxCents,
        pricesIncludeTax: includes,
        // A remission note is paid by nobody: the plan states no payment
        payments: [],
        condition: FiscalOperationCondition.IMMEDIATE
      }
    })
  }

  // The invoices of an excluded subject come last of all, for the same reason: they draw from the same seeded generator, and every step
  // before them keeps the values the same seed gave it. A purchase stands alone (it names no document), and these are all of goods bought
  // from a person, so the income tax withheld is stated as 0.00 for every one: the rule that withholds is not decided here
  // (`IMPLEMENTATION_PLAN.md`, D20b).
  for (let n = 1; n <= counts.excludedSubjects; n += 1) {
    const id = `FSE-${String(n).padStart(3, '0')}`
    const shape = shapes[n % shapes.length] as (typeof shapes)[number]
    const specs = specsOf(rng, shape).map(spec => ({ ...spec, service: false, unit: '59' }))
    const gross = specs.reduce((sum, spec) => sum + spec.quantity * spec.unitPriceCents, 0)
    const discount = rng.chance(0.3) ? roundDiv(gross * rng.int(1, 20), 100) : 0
    const seller = sellerOf(rng)
    const total = gross - discount
    steps.push({
      kind: 'sale',
      id,
      bucket: SvConformanceBuckets.EXCLUDED_SUBJECT,
      tags: ['excluded_subject', ...seller.tags, shape, ...(discount > 0 ? ['discount'] : [])],
      input: {
        kind: FiscalDocumentKind.PURCHASE,
        credited: null,
        ...base(id, 'excludedSubject'),
        issuedAt: issuedAt(SvConformanceLimits.MAX_BACK_MINUTES),
        receiver: seller.receiver,
        lines: specs.map(spec => ({
          description: spec.description,
          quantity: spec.quantity,
          unitPriceCents: spec.unitPriceCents,
          taxRateBps: null,
          taxCents: 0,
          totalCents: spec.quantity * spec.unitPriceCents,
          taxTreatment: null,
          itemKind: '1',
          unit: spec.unit
        })),
        shippingCents: 0,
        shippingTaxCents: 0,
        discountCents: discount,
        totalCents: total,
        taxCents: 0,
        pricesIncludeTax: false,
        withheldIncomeTaxCents: 0,
        ...paymentOf(rng, total)
      }
    })
  }

  return steps
}

// What the authority asks to be accepted with a seal, by the id of the document type
export function svConformanceTargets(
  counts: Partial<SvConformanceCounts> = {}
): ConformanceTargets {
  const wanted = { ...SvConformanceDefaults, ...counts }
  return {
    buckets: {
      [SvConformanceBuckets.INVOICE]: wanted.invoices,
      [SvConformanceBuckets.TAX_CREDIT]: wanted.taxCredits,
      [SvConformanceBuckets.CREDIT_NOTE]: Math.min(wanted.creditNotes, wanted.taxCredits),
      [SvConformanceBuckets.DEBIT_NOTE]: Math.min(wanted.debitNotes, wanted.taxCredits),
      [SvConformanceBuckets.REMISSION_NOTE]: wanted.remissionNotes,
      [SvConformanceBuckets.EXCLUDED_SUBJECT]: wanted.excludedSubjects
    },
    voids: wanted.voids,
    contingencies: wanted.contingencies
  }
}

// A dry run has no accepted tax credit document for a note (credit or debit) to name: what the provider keeps of an accepted one is what its own build says of it
export function svDryRunCredited(
  built: BuiltDocument,
  input: FiscalBuildInput
): FiscalCreditedDocument | null {
  const id = built.payload['identificacion']
  if (typeof id !== 'object' || id === null) return null
  const record = id as Record<string, unknown>
  const code = record['codigoGeneracion']
  const control = record['numeroControl']
  const date = record['fecEmi']
  if (typeof code !== 'string' || typeof control !== 'string' || typeof date !== 'string')
    return null
  return {
    documentType: built.documentType,
    externalNumber: control,
    issuedAt: input.issuedAt,
    providerData: {
      [SvProviderDataKeys.GENERATION_CODE]: code,
      [SvProviderDataKeys.CONTROL_NUMBER]: control,
      [SvProviderDataKeys.ISSUE_DATE]: date
    }
  }
}

// The highest number of a series the plan used (the documents made for the invalidations and the contingencies share the series of the
// minimum): the `--offset` of the run that follows it, so that no control number is used twice
export function svNextOffset(steps: readonly ConformanceStep[]): number {
  return steps.reduce(
    (highest, step) => ('input' in step ? Math.max(highest, step.input.correlative) : highest),
    0
  )
}

// Whether the moment is in the first minutes of a month of El Salvador, when a document could only be dated in the month before
export function svMonthJustStarted(now: Date): boolean {
  const local = new Date(now.getTime() - SALVADOR_OFFSET_HOURS * 60 * MINUTE_MS)
  const start = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1)
  return local.getTime() - start < 30 * MINUTE_MS
}
