import {
  FiscalDocumentKind,
  FiscalOperationCondition,
  PaymentMethod,
  TaxTreatment
} from '@platform/core/domain'
import type {
  BuiltDocument,
  FiscalBuildContingency,
  FiscalBuildInput,
  FiscalIssuerInput,
  FiscalReceiver,
  FiscalReceiverField,
  FiscalTypeInput
} from '@platform/fiscal/sdk'

import { activityName, isUnit } from './sv-catalog'
import {
  SvBuildError,
  SvBuildErrors,
  type SvBuildErrorCode,
  SvCodePatterns,
  SvCreditableDocuments,
  SvCurrency,
  SvDebitableDocuments,
  SvDefaultPaymentForm,
  SvDeferredTerm,
  SvDocumentTypes,
  type SvDocumentType,
  SvEnvironmentCodes,
  SvGenerationType,
  SvItemDefaults,
  SvLimits,
  SvOperationCondition,
  SvPaymentForms,
  SvProviderDataKeys,
  SvRelatedDocument,
  SvSchemaVersions,
  SvShippingLine,
  SvTransmission,
  SvVat
} from './sv-constants'
import { readContingency, type SvContingencyProblem } from './sv-contingency-reason'
import { allocate, dollars, dollars8, roundDiv, SCALE_8, toScaled8 } from './sv-decimal'
import { addMonths } from './sv-invalidation'
import {
  addressOf,
  digitsOf,
  identityOf,
  issuerProblems,
  lacks,
  missingForBusiness,
  validEmail,
  validPhone
} from './sv-parties'
import { salvadorMoment } from './sv-time'
import { amountInWords } from './sv-words'

// The pure construction of the documents of El Salvador from the sale the platform hands over: the invoice to a final consumer (01), the
// tax credit document to a taxpayer (03), the credit note (05) and the debit note (06). Everything is exact (integers and the rounding of the authority,
// Funcional §XXI), and what cannot be made right is refused with a code instead of being sent wrong.

type Treatment = 'taxed' | 'exempt' | 'notSubject'

interface Item {
  readonly description: string
  readonly quantity: number
  readonly unitPriceCents: number
  // quantity x unit price, as the order has it (with its tax when the prices include it), before the discount
  readonly grossCents: number
  // The share of the discount of the order this item took (the shipping fee takes none)
  readonly discountCents: number
  // The tax of the item after its discount, from the order
  readonly taxCents: number
  readonly treatment: Treatment
  readonly kind: number
  readonly unit: number
}

// A tax credit document is for a taxpayer: the receiver has a registration number. Everyone else gets an invoice.
export function resolveDocumentType(input: FiscalTypeInput): SvDocumentType {
  if (input.kind === FiscalDocumentKind.CREDIT_NOTE) return SvDocumentTypes.CREDIT_NOTE
  if (input.kind === FiscalDocumentKind.DEBIT_NOTE) return SvDocumentTypes.DEBIT_NOTE
  return lacks(input.receiver.registrationId) ? SvDocumentTypes.INVOICE : SvDocumentTypes.TAX_CREDIT
}

function treatmentOf(taxTreatment: TaxTreatment | null, taxRateBps: number | null): Treatment {
  // An order made before the treatment was kept: a rate says it was taxed; nothing says nothing, and nothing is guessed
  if (taxTreatment === null) {
    if (taxRateBps === null) throw new SvBuildError(SvBuildErrors.TAX_TREATMENT_UNKNOWN)
    return 'taxed'
  }
  if (taxTreatment === TaxTreatment.EXEMPT) return 'exempt'
  if (taxTreatment === TaxTreatment.NOT_SUBJECT) return 'notSubject'
  return 'taxed'
}

// The description of an item: what the order calls it, never empty (the schema asks for one character at least)
function describe(text: string): string {
  const description = text.trim().slice(0, SvLimits.ITEM_DESCRIPTION_MAX)
  if (description === '') throw new SvBuildError(SvBuildErrors.ITEM_DESCRIPTION_EMPTY)
  return description
}

function itemsOf(input: FiscalBuildInput): Item[] {
  if (input.lines.length === 0) throw new SvBuildError(SvBuildErrors.NO_ITEMS)
  // A line the document cannot describe: no units, or an amount that is not a whole number of cents
  for (const line of input.lines) {
    if (!Number.isSafeInteger(line.quantity) || line.quantity < 1) {
      throw new SvBuildError(SvBuildErrors.QUANTITY_INVALID)
    }
    for (const cents of [line.totalCents, line.unitPriceCents, line.taxCents]) {
      if (!Number.isSafeInteger(cents) || cents < 0) {
        throw new SvBuildError(SvBuildErrors.SALE_TOTALS_MISMATCH)
      }
    }
  }
  const gross = input.lines.map(line => line.totalCents)
  if (input.discountCents > gross.reduce((sum, value) => sum + value, 0)) {
    throw new SvBuildError(SvBuildErrors.SALE_TOTALS_MISMATCH)
  }
  const discounts = allocate(input.discountCents, gross)
  const items: Item[] = input.lines.map((line, index) => {
    const treatment = treatmentOf(line.taxTreatment, line.taxRateBps)
    if (treatment === 'taxed' && line.taxRateBps !== SvVat.RATE_BPS) {
      throw new SvBuildError(SvBuildErrors.TAX_RATE_UNSUPPORTED)
    }
    const unit = Number(line.unit)
    const kind = Number(line.itemKind)
    const safeKind =
      Number.isInteger(kind) && kind >= 1 && kind <= 4 ? kind : SvItemDefaults.KIND_GOODS
    return {
      description: describe(line.description),
      quantity: line.quantity,
      unitPriceCents: line.unitPriceCents,
      grossCents: line.totalCents,
      discountCents: discounts[index] ?? 0,
      taxCents: treatment === 'taxed' ? line.taxCents : 0,
      treatment,
      kind: safeKind,
      unit: unitOf(unit, safeKind)
    }
  })
  // The shipping fee is a service of its own: taxed when the order taxed it, exempt when it carried no tax
  if (input.shippingCents > 0) {
    items.push({
      description: SvShippingLine.DESCRIPTION,
      quantity: 1,
      unitPriceCents: input.shippingCents,
      grossCents: input.shippingCents,
      discountCents: 0,
      taxCents: input.shippingTaxCents,
      treatment: input.shippingTaxCents > 0 ? 'taxed' : 'exempt',
      kind: SvItemDefaults.KIND_SERVICE,
      unit: SvItemDefaults.UNIT_OTHER
    })
  }
  if (items.length > SvLimits.ITEMS_MAX) throw new SvBuildError(SvBuildErrors.TOO_MANY_ITEMS)
  // With the tax inside the price it cannot be more than what the item was sold for
  if (
    input.pricesIncludeTax &&
    items.some(item => item.taxCents > item.grossCents - item.discountCents)
  ) {
    throw new SvBuildError(SvBuildErrors.SALE_TOTALS_MISMATCH)
  }
  // What the order took must be what the document is for: nothing inconsistent is ever signed
  const paid = items.reduce((sum, item) => sum + item.grossCents - item.discountCents, 0)
  const tax = items.reduce((sum, item) => sum + item.taxCents, 0)
  if (
    tax !== input.taxCents ||
    paid + (input.pricesIncludeTax ? 0 : input.taxCents) !== input.totalCents
  ) {
    throw new SvBuildError(SvBuildErrors.SALE_TOTALS_MISMATCH)
  }
  return items
}

const sumOf = (
  items: readonly Item[],
  treatment: Treatment,
  figure: (item: Item) => number
): number =>
  items.filter(item => item.treatment === treatment).reduce((sum, item) => sum + figure(item), 0)

// The tax of the authority's formula over the taxed sales of the document, against the tax of the order: a difference of more than the
// hundredth the authority tolerates is not signed (the books and the document would not say the same)
function checkTax(formulaCents: number, input: FiscalBuildInput): void {
  if (Math.abs(formulaCents - input.taxCents) > SvLimits.TOLERANCE_CENTS) {
    throw new SvBuildError(SvBuildErrors.TAX_OUTSIDE_TOLERANCE)
  }
}

// ---------------------------------------------------------------- the common parts

// A document made in contingency is deferred (model 2) and transmitted as a contingency (operation 2), with the reason of CAT-005; the reason
// that is "other" carries the person's own words, and the others have none (Manual Técnico §3.3)
// What each problem of the reason is called by the builder
const BuildProblems: Record<SvContingencyProblem, SvBuildErrorCode> = {
  reason: SvBuildErrors.CONTINGENCY_REASON_UNKNOWN,
  motive_required: SvBuildErrors.CONTINGENCY_MOTIVE_REQUIRED,
  motive_too_long: SvBuildErrors.CONTINGENCY_MOTIVE_TOO_LONG
}

function transmissionOf(contingency: FiscalBuildContingency | undefined): Record<string, unknown> {
  if (contingency === undefined) {
    return {
      tipoModelo: SvTransmission.MODEL_PREVIOUS,
      tipoOperacion: SvTransmission.OPERATION_NORMAL,
      tipoContingencia: null,
      motivoContin: null
    }
  }
  const read = readContingency(contingency.reason, contingency.motive)
  if (!read.ok) throw new SvBuildError(BuildProblems[read.problem])
  return {
    tipoModelo: SvTransmission.MODEL_DEFERRED,
    tipoOperacion: SvTransmission.OPERATION_CONTINGENCY,
    tipoContingencia: read.reason,
    motivoContin: read.motive
  }
}

// A credit note and a debit note name the document they change and have the same shape in the schema of the authority
const isNote = (type: SvDocumentType): boolean =>
  type === SvDocumentTypes.CREDIT_NOTE || type === SvDocumentTypes.DEBIT_NOTE

function identification(type: SvDocumentType, input: FiscalBuildInput): Record<string, unknown> {
  const issuer = input.issuer
  const moment = salvadorMoment(input.issuedAt)
  const sequence = String(input.correlative).padStart(SvLimits.CONTROL_SEQUENCE_DIGITS, '0')
  return {
    version: SvSchemaVersions[type],
    ambiente: SvEnvironmentCodes[issuer.environment],
    tipoDte: type,
    // DTE-{type}-{establishment}{point of sale}-{correlative}: the codes of the issuer (checked) and the number of the series
    numeroControl: `DTE-${type}-${(issuer.establishmentCode ?? '').trim()}${(issuer.pointOfSaleCode ?? '').trim()}-${sequence}`,
    codigoGeneracion: input.documentUuid.toUpperCase(),
    ...transmissionOf(input.contingency),
    fecEmi: moment.date,
    horEmi: moment.time,
    tipoMoneda: SvCurrency,
    ...(isNote(type) ? { fusion: null } : {})
  }
}

function emisor(type: SvDocumentType, issuer: FiscalIssuerInput): Record<string, unknown> {
  if (issuerProblems(issuer).length > 0) throw new SvBuildError(SvBuildErrors.ISSUER_INCOMPLETE)
  const activity = (issuer.activityCode ?? '').trim()
  return {
    nit: digitsOf(issuer.taxId),
    nrc: digitsOf(issuer.registrationId),
    nombre: issuer.legalName.trim(),
    codActividad: activity,
    descActividad: (activityName(activity) ?? '').slice(0, SvLimits.ACTIVITY_DESCRIPTION_MAX),
    nombreComercial: null,
    direccion: addressOf(issuer.address),
    telefono: (issuer.phone ?? '').trim(),
    correo: (issuer.email ?? '').trim(),
    // The codes of the establishment and the point of sale are part of the emisor of the invoice and of the tax credit document; the
    // schema of the credit note and of the debit note has none
    ...(isNote(type)
      ? {}
      : {
          codEstable: (issuer.establishmentCode ?? '').trim(),
          codPuntoVenta: (issuer.pointOfSaleCode ?? '').trim()
        })
  }
}

// The contact of a receiver goes only when it is valid (an invalid one is not sent: it is a courtesy, never a reason to refuse a sale)
const contactEmail = (value: string | null): string | null =>
  value !== null && validEmail(value.trim()) ? value.trim() : null
const contactPhone = (value: string | null): string | null =>
  value !== null && validPhone(value.trim()) ? value.trim() : null

// The receiver of a tax credit document, a credit note or a debit note: a taxpayer, with everything the schema asks
function businessReceiver(
  receiver: FiscalReceiver,
  identityKey: 'nit' | 'tipoDocumento'
): Record<string, unknown> {
  const identity = identityOf(receiver.taxId, receiver.documentType)
  const address = addressOf(receiver.address)
  const activity = (receiver.economicActivity ?? '').trim()
  if (
    identity === null ||
    address === null ||
    activityName(activity) === null ||
    lacks(receiver.name)
  ) {
    throw new SvBuildError(SvBuildErrors.RECEIVER_UNREADABLE)
  }
  const common = {
    nrc: digitsOf(receiver.registrationId),
    nombre: (receiver.name ?? '').trim(),
    codActividad: activity,
    descActividad: (activityName(activity) ?? '').slice(0, SvLimits.ACTIVITY_DESCRIPTION_MAX),
    nombreComercial: null,
    direccion: address,
    telefono: contactPhone(receiver.phone),
    correo: contactEmail(receiver.email)
  }
  return identityKey === 'nit'
    ? { nit: identity.number, ...common }
    : { tipoDocumento: identity.type, numDocumento: identity.number, ...common }
}

// The unit of an item (CAT-014): a service, and an item of kind 4 (charges that do not touch the base), are always 99 "other"
// (Normativa DTE v2.0, Anexo II, page 64, field 85); a good takes the unit of the order when the catalog knows it
function unitOf(unit: number, kind: number): number {
  if (kind === SvItemDefaults.KIND_SERVICE || kind === SvItemDefaults.KIND_OTHER_CHARGES) {
    return SvItemDefaults.UNIT_OTHER
  }
  return Number.isInteger(unit) && isUnit(unit) ? unit : SvItemDefaults.UNIT
}

// The receiver of an invoice: a final consumer says what they want to and nothing more is asked (the notice of the authority of
// 2024-09-05 forbids asking for an identity document under the threshold). Null when the order has nothing about them.
function consumerReceiver(receiver: FiscalReceiver): Record<string, unknown> | null {
  const identity = identityOf(receiver.taxId, receiver.documentType)
  const name = lacks(receiver.name)
    ? null
    : (receiver.name ?? '').trim().slice(0, SvLimits.NAME_MAX)
  const phone = contactPhone(receiver.phone)
  const email = contactEmail(receiver.email)
  if (identity === null && name === null && phone === null && email === null) return null
  return {
    tipoDocumento: identity?.type ?? null,
    numDocumento: identity?.number ?? null,
    nrc: registrationDigits(receiver.registrationId),
    nombre: name,
    // Anexo IV (fields 43.1, 44.1, 47.1, 48.1 and 50, pages 106-107): the authority validates these as null in an invoice, and the
    // complement is null when the department is, so the whole address goes as null: the delivery address is not the receiver's
    codActividad: null,
    descActividad: null,
    direccion: null,
    telefono: phone,
    correo: email
  }
}

function registrationDigits(registrationId: string | null): string | null {
  const digits = digitsOf(registrationId)
  return SvCodePatterns.REGISTRATION.test(digits) ? digits : null
}

// How it was paid: the payments of the order in the forms of the authority, and the condition of the operation
// A document with nothing to pay is always cash, whatever the order says (Anexo IV, field 159.2, page 121)
const isCredit = (input: FiscalBuildInput, totalPagar: number): boolean =>
  input.condition === FiscalOperationCondition.DEFERRED && totalPagar > 0
const conditionOf = (input: FiscalBuildInput, totalPagar: number): number =>
  isCredit(input, totalPagar) ? SvOperationCondition.CREDIT : SvOperationCondition.CASH

function payments(
  input: FiscalBuildInput,
  totalPagar: number
): { pagos: Record<string, unknown>[]; condicion: number } {
  const credit = isCredit(input, totalPagar)
  const source =
    input.payments.length > 0
      ? input.payments
      : [{ method: PaymentMethod.CASH, amountCents: totalPagar, reference: null }]
  const recorded = source.reduce((sum, payment) => sum + payment.amountCents, 0)
  // On credit the order may have been paid in part (a deposit): what is recorded cannot be more than the total, and the document
  // declares the credit, not the payments; paid in cash the payments are the total
  if (credit ? recorded > totalPagar : recorded !== totalPagar) {
    throw new SvBuildError(SvBuildErrors.SALE_TOTALS_MISMATCH)
  }
  // On credit nothing is paid yet (Anexo IV, fields 160.5, 161.6 and 162.5, page 121): no form, $0.00 and no reference, and the
  // term, which stays required (163.2 and 164.2)
  if (credit) {
    return {
      condicion: SvOperationCondition.CREDIT,
      pagos: [
        {
          codigo: null,
          montoPago: dollars(0),
          referencia: null,
          plazo: SvDeferredTerm.UNIT,
          periodo: SvDeferredTerm.PERIOD
        }
      ]
    }
  }
  return {
    condicion: conditionOf(input, totalPagar),
    pagos: source.map(payment => ({
      codigo: SvPaymentForms[payment.method] ?? SvDefaultPaymentForm,
      montoPago: dollars(payment.amountCents),
      // The reference is typed by a person; the schema takes 50 characters
      referencia:
        payment.reference === null
          ? null
          : payment.reference.trim().slice(0, SvLimits.PAYMENT_REFERENCE_MAX) || null,
      plazo: null,
      periodo: null
    }))
  }
}

// ---------------------------------------------------------------- the invoice (01): prices with the tax inside

function invoiceBody(input: FiscalBuildInput, items: readonly Item[]): Record<string, unknown> {
  if (!input.pricesIncludeTax) throw new SvBuildError(SvBuildErrors.PRICES_EXCLUDE_TAX_FOR_INVOICE)
  const paid = (item: Item): number => item.grossCents - item.discountCents
  const taxedPaid = sumOf(items, 'taxed', paid)
  // The tax inside the taxed sales by the formula of the authority: sales / 1.13 x 13 %
  checkTax(Number(roundDiv(BigInt(taxedPaid) * BigInt(SvVat.RATE_BPS / 100), SvVat.DIVISOR)), input)
  const cuerpo = items.map((item, index) => {
    const amount = paid(item)
    return {
      numItem: index + 1,
      tipoItem: item.kind,
      numeroDocumento: null,
      codigo: null,
      codTributo: null,
      descripcion: item.description,
      cantidad: item.quantity,
      uniMedida: item.unit,
      precioUni: dollars(item.unitPriceCents),
      montoDescu: dollars(item.discountCents),
      ventaNoSuj: item.treatment === 'notSubject' ? dollars(amount) : 0,
      ventaExenta: item.treatment === 'exempt' ? dollars(amount) : 0,
      ventaGravada: item.treatment === 'taxed' ? dollars(amount) : 0,
      tributos: null,
      psv: 0,
      noGravado: 0,
      // Informative: the tax inside the item, sales / 1.13 x 13 % to eight decimals
      ivaItem:
        item.treatment === 'taxed'
          ? dollars8(
              roundDiv(BigInt(amount) * BigInt(SvVat.RATE_BPS / 100) * 1_000_000n, SvVat.DIVISOR)
            )
          : 0
    }
  })
  const totalNoSuj = sumOf(items, 'notSubject', paid)
  const totalExenta = sumOf(items, 'exempt', paid)
  const subTotalVentas = totalNoSuj + totalExenta + taxedPaid
  const totalPagar = subTotalVentas
  const how = payments(input, totalPagar)
  return {
    cuerpoDocumento: cuerpo,
    resumen: {
      totalNoSuj: dollars(totalNoSuj),
      totalExenta: dollars(totalExenta),
      totalGravada: dollars(taxedPaid),
      subTotalVentas: dollars(subTotalVentas),
      // The discount of the order is spread over the items (the field of each item); the global discounts of the summary stay empty
      descuNoSuj: 0,
      descuExenta: 0,
      descuGravada: 0,
      porcentajeDescuento: 0,
      totalDescu: dollars(items.reduce((sum, item) => sum + item.discountCents, 0)),
      tributos: null,
      subTotal: dollars(subTotalVentas),
      ivaRete: 0,
      montoTotalOperacion: dollars(subTotalVentas),
      totalNoGravado: 0,
      totalPagar: dollars(totalPagar),
      totalLetras: amountInWords(totalPagar),
      // The tax of the order, which the books declare: the formula agrees with it within the hundredth (checked above)
      totalIva: dollars(input.taxCents),
      saldoFavor: 0,
      condicionOperacion: how.condicion,
      pagos: how.pagos,
      numPagoElectronico: null,
      observaciones: null
    },
    ventaTercero: null,
    otrosDocumentos: null,
    apendice: null
  }
}

// ---------------------------------------------------------------- the tax credit document (03), the credit note (05) and the debit note (06): net prices

interface NetItem {
  readonly item: Item
  // The sale of the item after its discount, in cents, without the tax
  readonly netCents: number
  readonly unitPrice8: bigint
  readonly discount8: bigint
}

function netItems(input: FiscalBuildInput, items: readonly Item[]): NetItem[] {
  return items.map(item => {
    const paid = item.grossCents - item.discountCents
    const taxInside = input.pricesIncludeTax && item.treatment === 'taxed'
    const netCents = taxInside ? paid - item.taxCents : paid
    const netScaled = toScaled8(netCents)
    // Before its discount the item is worth its price without the tax; never less than what it was sold for (a rounding of the order
    // must not make a discount negative)
    const grossScaled = taxInside
      ? roundDiv(BigInt(item.grossCents) * SCALE_8, SvVat.DIVISOR)
      : toScaled8(item.grossCents)
    // An item with no discount is worth what it was sold for: the rounding of the tax of the order never shows as a discount
    const before = item.discountCents === 0 || grossScaled < netScaled ? netScaled : grossScaled
    return {
      item,
      netCents,
      unitPrice8: roundDiv(before, BigInt(item.quantity)),
      discount8: before - netScaled
    }
  })
}

function netBody(
  type: SvDocumentType,
  input: FiscalBuildInput,
  items: readonly Item[],
  relatedCode: string | null
): Record<string, unknown> {
  const net = netItems(input, items)
  const netOf = (treatment: Treatment): number =>
    net.filter(row => row.item.treatment === treatment).reduce((sum, row) => sum + row.netCents, 0)
  const totalGravada = netOf('taxed')
  // The tax of the taxed sales by the formula of the authority: sales x 13 %
  checkTax(Number(roundDiv(BigInt(totalGravada) * BigInt(SvVat.RATE_BPS), 10_000n)), input)
  // A credit note and a debit note share the body; the debit note also has the electronic payment number in its summary
  const credit = isNote(type)
  const debit = type === SvDocumentTypes.DEBIT_NOTE
  const cuerpo = net.map((row, index) => {
    const { item } = row
    const taxed = item.treatment === 'taxed'
    return {
      numItem: index + 1,
      tipoItem: item.kind,
      // A credit note and a debit note name, in each item, the document the item belongs to
      numeroDocumento: credit ? relatedCode : null,
      codigo: null,
      codTributo: null,
      descripcion: item.description,
      cantidad: item.quantity,
      uniMedida: item.unit,
      precioUni: dollars8(row.unitPrice8),
      montoDescu: dollars8(row.discount8),
      ventaNoSuj: item.treatment === 'notSubject' ? dollars(row.netCents) : 0,
      ventaExenta: item.treatment === 'exempt' ? dollars(row.netCents) : 0,
      ventaGravada: taxed ? dollars(row.netCents) : 0,
      tributos: taxed ? [SvVat.CODE] : null,
      ...(credit
        ? { noGravado: 0, ivaPerci: 0, totalIva: dollars(item.taxCents), ivaRete: 0 }
        : { psv: 0, noGravado: 0 })
    }
  })
  const totalNoSuj = netOf('notSubject')
  const totalExenta = netOf('exempt')
  const subTotalVentas = totalNoSuj + totalExenta + totalGravada
  const montoTotal = subTotalVentas + input.taxCents
  // A credit note or a debit note says only the condition: what it gives back or charges is not a payment, so the payments of the order are
  // not read
  const how = credit
    ? { pagos: [], condicion: conditionOf(input, montoTotal) }
    : payments(input, montoTotal)
  const tributos =
    totalGravada > 0
      ? [{ codigo: SvVat.CODE, descripcion: SvVat.DESCRIPTION, valor: dollars(input.taxCents) }]
      : null
  // The total of the discounts is informative and has two decimals in the summary
  const totalDescu = dollars(
    Number(
      roundDiv(
        net.reduce((sum, row) => sum + row.discount8, 0n),
        1_000_000n
      )
    )
  )
  const resumen: Record<string, unknown> = credit
    ? {
        totalNoSuj: dollars(totalNoSuj),
        totalExenta: dollars(totalExenta),
        totalGravada: dollars(totalGravada),
        subTotalVentas: dollars(subTotalVentas),
        totalDescu,
        tributos,
        montoTotalOperacion: dollars(montoTotal),
        ivaPerci: 0,
        totalIva: dollars(input.taxCents),
        ivaRete: 0,
        totalNoGravado: 0,
        totalPagar: dollars(montoTotal),
        totalLetras: amountInWords(montoTotal),
        condicionOperacion: how.condicion,
        ...(debit ? { numPagoElectronico: null } : {}),
        observaciones: null,
        codigoRetencionMH: null
      }
    : {
        totalNoSuj: dollars(totalNoSuj),
        totalExenta: dollars(totalExenta),
        totalGravada: dollars(totalGravada),
        subTotalVentas: dollars(subTotalVentas),
        descuNoSuj: 0,
        descuExenta: 0,
        descuGravada: 0,
        porcentajeDescuento: 0,
        totalDescu,
        tributos,
        subTotal: dollars(subTotalVentas),
        ivaPerci: 0,
        ivaRete: 0,
        montoTotalOperacion: dollars(montoTotal),
        totalNoGravado: 0,
        totalPagar: dollars(montoTotal),
        totalLetras: amountInWords(montoTotal),
        saldoFavor: 0,
        condicionOperacion: how.condicion,
        pagos: how.pagos,
        numPagoElectronico: null,
        observaciones: null
      }
  return {
    cuerpoDocumento: cuerpo,
    resumen,
    ventaTercero: null,
    ...(credit ? { apendice: null } : { otrosDocumentos: null, apendice: null })
  }
}

// ---------------------------------------------------------------- a note names the document it changes

function relatedDocument(
  input: FiscalBuildInput,
  allowed: readonly SvDocumentType[]
): { type: string; code: string; date: string } {
  const credited = input.credited
  if (credited === null) throw new SvBuildError(SvBuildErrors.CREDITED_DOCUMENT_UNKNOWN)
  if (!(allowed as readonly string[]).includes(credited.documentType)) {
    throw new SvBuildError(SvBuildErrors.CREDITED_DOCUMENT_NOT_CREDITABLE)
  }
  const data = credited.providerData
  const code = data?.[SvProviderDataKeys.GENERATION_CODE]
  // The date of the original is the one it was generated with (its `fecEmi`), which the provider kept when the authority accepted it: the
  // instant of the acceptance is another day when a document is sent the day after it was made, so it is never a substitute
  const issued = data?.[SvProviderDataKeys.ISSUE_DATE]
  if (
    typeof code !== 'string' ||
    code.trim() === '' ||
    typeof issued !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(issued)
  ) {
    throw new SvBuildError(SvBuildErrors.CREDITED_DOCUMENT_UNKNOWN)
  }
  // The note is generated within the months the authority allows after the document it names: both dates are the ones the documents
  // carry (`fecEmi`, in Salvador time), so the answer never depends on when the note is sent. ISO dates compare as text.
  // A date of the right shape that is no day of the calendar (2026-02-30) is a date that was not kept right
  let lastDay: string
  try {
    lastDay = addMonths(issued, SvRelatedDocument.DEADLINE_MONTHS)
  } catch {
    throw new SvBuildError(SvBuildErrors.CREDITED_DOCUMENT_UNKNOWN)
  }
  if (salvadorMoment(input.issuedAt).date > lastDay) {
    throw new SvBuildError(SvBuildErrors.RELATED_DOCUMENT_DEADLINE_PASSED)
  }
  // The generation code of a document is in capitals (its own `codigoGeneracion`)
  return { type: credited.documentType, code: code.trim().toUpperCase(), date: issued }
}

// ---------------------------------------------------------------- the document

export function buildDocument(input: FiscalBuildInput): BuiltDocument {
  const type = resolveDocumentType(input)
  const missing: FiscalReceiverField[] =
    type === SvDocumentTypes.INVOICE ? [] : missingForBusiness(input.receiver)
  // A receiver that lacks what the type needs is not built into a document nobody could send: core refuses it for a person to fix
  if (missing.length > 0) return { documentType: type, payload: {}, missingReceiverFields: missing }
  const items = itemsOf(input)
  const base = {
    identificacion: identification(type, input),
    emisor: emisor(type, input.issuer)
  }
  if (type === SvDocumentTypes.INVOICE) {
    return {
      documentType: type,
      payload: {
        ...base,
        documentoRelacionado: null,
        receptor: consumerReceiver(input.receiver),
        ...invoiceBody(input, items)
      },
      missingReceiverFields: []
    }
  }
  if (type === SvDocumentTypes.TAX_CREDIT) {
    return {
      documentType: type,
      payload: {
        ...base,
        documentoRelacionado: null,
        receptor: businessReceiver(input.receiver, 'nit'),
        ...netBody(type, input, items, null)
      },
      missingReceiverFields: []
    }
  }
  const related = relatedDocument(
    input,
    type === SvDocumentTypes.DEBIT_NOTE ? SvDebitableDocuments : SvCreditableDocuments
  )
  // The receiver of a note is the one of the tax credit document it names, by tax number (identity document 36)
  return {
    documentType: type,
    payload: {
      ...base,
      documentoRelacionado: [
        {
          tipoDocumento: related.type,
          tipoGeneracion: SvGenerationType.ELECTRONIC,
          numeroDocumento: related.code,
          fechaEmision: related.date
        }
      ],
      receptor: businessReceiver(input.receiver, 'tipoDocumento'),
      ...netBody(type, input, items, related.code)
    },
    missingReceiverFields: []
  }
}
