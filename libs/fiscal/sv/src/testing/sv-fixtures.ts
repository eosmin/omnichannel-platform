import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { Ajv } from 'ajv'

import {
  FiscalDocumentKind,
  FiscalEnvironment,
  FiscalOperationCondition,
  PaymentMethod,
  TaxTreatment
} from '@platform/core/domain'
import type {
  FiscalBuildInput,
  FiscalCreditedDocument,
  FiscalIssuerInput,
  FiscalLine,
  FiscalReceiver,
  StoredFiscalDocument
} from '@platform/fiscal/sdk'

import { buildDocument } from '../sv-build'
import { SvProviderDataKeys } from '../sv-constants'

// Fixtures of the specs of this package: a sale the way core hands it over, and the JSON schemas of the authority to check a document
// against (svfe-json-schemas, copied under ../schemas, see the README).

export const ISSUER: FiscalIssuerInput = {
  legalName: 'Tienda Demo S.A. de C.V.',
  taxId: '0614-010101-101-1',
  registrationId: '123456-7',
  address: {
    department: '06',
    municipality: '23',
    district: '01',
    complement: 'Calle 1, Colonia Centro'
  },
  activityCode: '47119',
  establishmentCode: 'M001',
  establishmentType: '02',
  pointOfSaleCode: 'P001',
  phone: '2222-0000',
  email: 'facturas@example.test',
  environment: FiscalEnvironment.SANDBOX
}

export const BUSINESS: FiscalReceiver = {
  name: 'Cliente Contribuyente S.A.',
  taxId: '0614-020202-102-3',
  registrationId: '765432-1',
  address: { department: '06', municipality: '20', district: '02', complement: 'Avenida 2' },
  email: 'compras@example.test',
  phone: '7777-0000',
  taxpayerType: null,
  economicActivity: '47119',
  documentType: null
}

export const CONSUMER: FiscalReceiver = {
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

export const line = (over: Partial<FiscalLine> = {}): FiscalLine => ({
  description: 'Camisa (M)',
  quantity: 2,
  unitPriceCents: 1130,
  taxRateBps: 1300,
  taxCents: 260,
  totalCents: 2260,
  taxTreatment: TaxTreatment.TAXED,
  ...over
})

// 2 x $11.30 and $5.65 of shipping, 13 % inside the prices: total $28.25, of which $3.25 of tax
export function sale(over: Partial<FiscalBuildInput> = {}): FiscalBuildInput {
  const totalCents = over.totalCents ?? 2825
  return {
    kind: FiscalDocumentKind.SALE,
    credited: null,
    sequenceNumber: 7,
    correlative: 41,
    documentUuid: '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed',
    issuedAt: '2026-11-17T03:30:15.000Z',
    orderNumber: 'ORD-1',
    currency: 'USD',
    issuer: ISSUER,
    receiver: CONSUMER,
    lines: [line()],
    shippingCents: 565,
    shippingTaxCents: 65,
    discountCents: 0,
    totalCents: 2825,
    taxCents: 325,
    pricesIncludeTax: true,
    // One payment of the whole order, like core makes it
    payments: [{ method: PaymentMethod.TRANSFER, amountCents: totalCents, reference: 'TRF-1' }],
    condition: FiscalOperationCondition.IMMEDIATE,
    ...over
  }
}

export const credited = (over: Record<string, unknown> = {}): FiscalCreditedDocument => ({
  documentType: '03',
  externalNumber: 'EXT-1',
  issuedAt: '2026-11-16T15:00:00.000Z',
  providerData: {
    [SvProviderDataKeys.GENERATION_CODE]: 'AC54E9DB-79C5-42CE-B430-EC552C97EFBA',
    [SvProviderDataKeys.ISSUE_DATE]: '2026-11-16',
    ...over
  }
})

const SCHEMAS = join(__dirname, '..', '..', 'schemas')
const FILES: Record<string, string> = {
  '01': 'fe-f-v2.json',
  '03': 'fe-ccf-v4.json',
  '05': 'fe-nc-v4.json',
  // The event that invalidates a document
  invalidation: 'invalidacion-v3.json',
  // The event that reports a contingency
  contingency: 'contingencia-v4.json'
}

// The validator of the authority's own schema for a type of document. `multipleOfPrecision` because a float is never an exact multiple of
// 0.01; `format: date` is checked by pattern.
const ajv = new Ajv({
  allErrors: true,
  strict: false,
  multipleOfPrecision: 5,
  formats: { date: /^\d{4}-\d{2}-\d{2}$/ }
})
const validators = new Map<string, ReturnType<typeof ajv.compile>>()

export function schemaErrors(type: string, payload: unknown): string[] {
  let validate = validators.get(type)
  if (validate === undefined) {
    const file = FILES[type]
    if (file === undefined) throw new Error(`no schema for the type ${type}`)
    validate = ajv.compile(JSON.parse(readFileSync(join(SCHEMAS, file), 'utf8')) as object)
    validators.set(type, validate)
  }
  return validate(payload)
    ? []
    : (validate.errors ?? []).map(error => `${error.instancePath} ${error.message ?? ''}`.trim())
}

// When the authority sealed the documents of the fixtures (`fhProcesamiento`: dd/MM/yyyy HH:mm:ss, El Salvador)
export const SEALED_AT = '16/11/2026 22:15:00'

// A document as the authority accepted it and core kept it: built from a sale, with the answer's seal in its provider data. What the
// invalidation reads.
export function acceptedDocument(over: Partial<FiscalBuildInput> = {}): StoredFiscalDocument {
  const built = buildDocument(sale(over))
  const id = built.payload['identificacion'] as { codigoGeneracion: string; numeroControl: string }
  return {
    documentType: built.documentType,
    externalNumber: id.numeroControl,
    providerData: {
      [SvProviderDataKeys.GENERATION_CODE]: id.codigoGeneracion,
      [SvProviderDataKeys.CONTROL_NUMBER]: id.numeroControl,
      [SvProviderDataKeys.RECEPTION_SEAL]: 'A'.repeat(40),
      // The hour the authority gave the seal, in its own time and format: the day the deadlines of an invalidation count from
      [SvProviderDataKeys.PROCESSED_AT]: SEALED_AT
    },
    payload: built.payload
  }
}
