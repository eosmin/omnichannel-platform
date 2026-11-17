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
  SvDocumentTypes,
  SvIdentityDocuments,
  SvProviderDataKeys,
  SvVat
} from '../sv-constants'
import { allocate } from '../sv-decimal'

// The plan of the minimum tests of the sandbox (Step 4B.7c-6; Funcional §XXIV): 90 invoices, 75 tax credit documents and 50 credit notes with
// seal, 5 invalidations and 5 contingencies, made of invented data in many shapes (receivers, tax treatments, discounts, rounding, payments,
// dates inside the term). Pure and deterministic: the same options give the same plan, so a run can be repeated and compared. Nothing here
// is read from the environment and nothing is a real person: the tax numbers and the names are made up.

export interface SvConformanceCounts {
  readonly invoices: number
  readonly taxCredits: number
  readonly creditNotes: number
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

export const SvConformanceDefaults: SvConformanceCounts = {
  invoices: 90,
  taxCredits: 75,
  creditNotes: 50,
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
  const series = { invoice: offset, taxCredit: offset, creditNote: offset }
  let sequence = offset
  const nowMs = options.now.getTime()
  const monthStart = Date.UTC(options.now.getUTCFullYear(), options.now.getUTCMonth(), 1)
  // A document is dated inside the term: a date before the moment it is sent and in the month of the run
  const issuedAt = (maxBackMinutes: number): string => {
    const room = Math.max(0, Math.floor((nowMs - monthStart) / MINUTE_MS) - 10)
    const back = rng.int(5, Math.max(5, Math.min(maxBackMinutes, 5 + room)))
    return new Date(nowMs - back * MINUTE_MS).toISOString()
  }
  const base = (
    id: string,
    type: 'invoice' | 'taxCredit' | 'creditNote'
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
    const { receiver, tags } = consumerOf(rng)
    const specs = specsOf(rng, shape)
    const shipping = rng.chance(0.4) ? rng.int(300, 1500) : 0
    const shippingTaxed = shipping > 0 && rng.chance(0.6)
    const gross = specs.reduce((sum, spec) => sum + spec.quantity * spec.unitPriceCents, 0)
    const discount = rng.chance(0.35) ? roundDiv(gross * rng.int(1, 20), 100) : 0
    const sale = compose(specs, shipping, shippingTaxed, discount, true)
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
    const made = invoiceInput(id, issuedAt(8 * 24 * MINUTES_PER_HOUR))
    steps.push({ kind: 'sale', id, tags: ['invoice', ...made.tags], input: made.input })
  }

  // The tax credit documents, and what each one holds, for the credit notes
  const taxCredits: {
    id: string
    input: FiscalBuildInput
    specs: LineSpec[]
    includes: boolean
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
      issuedAt: issuedAt(8 * 24 * MINUTES_PER_HOUR),
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
    taxCredits.push({ id, input, specs, includes })
    steps.push({
      kind: 'sale',
      id,
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
    const sale = compose(specs, 0, false, 0, parent.includes)
    steps.push({
      kind: 'credit_note',
      id,
      parent: parent.id,
      tags: ['credit_note', whole ? 'whole_return' : 'partial_return'],
      input: {
        kind: FiscalDocumentKind.CREDIT_NOTE,
        credited: null,
        ...base(id, 'creditNote'),
        issuedAt: issuedAt(2 * 24 * MINUTES_PER_HOUR),
        receiver: parent.input.receiver,
        lines: sale.lines,
        shippingCents: 0,
        shippingTaxCents: 0,
        discountCents: 0,
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
    const endedAt = new Date(nowMs - 10 * MINUTE_MS)
    const startedAt = new Date(nowMs - 3 * 60 * MINUTE_MS)
    const documents: string[] = []
    for (let k = 1; k <= counts.deferredPerContingency; k += 1) {
      const id = `DEF-${n}-${k}`
      const when = new Date(startedAt.getTime() + rng.int(1, 150) * MINUTE_MS).toISOString()
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
  return steps
}

// What the authority asks to be accepted with a seal, by the id of the document type
export function svConformanceTargets(
  counts: Partial<SvConformanceCounts> = {}
): ConformanceTargets {
  const wanted = { ...SvConformanceDefaults, ...counts }
  return {
    documents: {
      [SvDocumentTypes.INVOICE]: wanted.invoices,
      [SvDocumentTypes.TAX_CREDIT]: wanted.taxCredits,
      [SvDocumentTypes.CREDIT_NOTE]: Math.min(wanted.creditNotes, wanted.taxCredits)
    },
    voids: wanted.voids,
    contingencies: wanted.contingencies
  }
}

// A dry run has no accepted tax credit document for a note to name: what the provider keeps of an accepted one is what its own build says of it
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
