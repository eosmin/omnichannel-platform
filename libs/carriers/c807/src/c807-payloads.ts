import { formatPhoneList, ShippingPayer } from '@platform/core/domain'
import { CarrierRejectedError, type CreateShipmentParams } from '@platform/plugins/sdk'

import {
  C807_GRAMS_PER_UNIT,
  C807Limits,
  C807Parcel,
  C807ServiceTypes,
  type C807WeightUnit
} from './c807-constants'
import type { C807Metadata } from './c807-credentials'

export type C807ServiceType = (typeof C807ServiceTypes)[keyof typeof C807ServiceTypes]

// The type of service follows the guide (owner, 2026-11-13; C807 answered on 2026-11-14):
//   product collected                                   -> CCE with the total to collect from the customer: C807 takes its
//                                                          fee out of what it collects, whoever is said to pay the shipping
//   product already paid, carrier paid by the recipient  -> SEC (C807 recognizes its own rate and keeps it)
//   nothing to collect, carrier paid by the sender       -> SER (an order paid in full, an exchange of total 0)
export function c807ServiceTypeOf(params: {
  // Whether the guide collects the product: the one question the type of service asks of the amount
  collects: boolean
  shippingPayer: ShippingPayer
}): C807ServiceType {
  if (params.collects) return C807ServiceTypes.COD
  return params.shippingPayer === ShippingPayer.RECIPIENT
    ? C807ServiceTypes.RECIPIENT_PAYS
    : C807ServiceTypes.STANDARD
}

function limited(value: string, max: number, what: string): string {
  const text = value.trim()
  if (text.length > max)
    throw new CarrierRejectedError(`The ${what} is longer than ${max} characters`)
  return text
}

// Money in whole cents to the decimal C807 asks for
export function c807Amount(cents: number): number {
  return Math.round(cents) / 100
}

const asId = (value: string, what: string): number => {
  const id = Number(value)
  if (!Number.isInteger(id) || id <= 0) {
    throw new CarrierRejectedError(`The ${what} is not a code of C807`)
  }
  return id
}

// One guide of the request `set_registro`. The recipient's phones are a single field joined with " / " (the owner reports it
// has no length limit, 2026-10-27).
export function toC807Guide(
  params: CreateShipmentParams,
  settings: { fallbackEmail?: string; weightUnit: C807WeightUnit }
): Record<string, unknown> {
  const { recipient } = params
  if (!recipient.locationIds)
    throw new CarrierRejectedError('The delivery place of C807 is missing')
  const type = c807ServiceTypeOf({
    collects: params.cod !== null,
    shippingPayer: params.shippingPayer
  })
  // C807 refuses a guide with no e-mail for the recipient (sandbox, 2026-11-14)
  // An e-mail longer than C807 takes is no e-mail of the customer: the fallback of the connection goes in its place
  const own =
    recipient.email !== undefined && recipient.email.length <= C807Limits.EMAIL_MAX_LENGTH
      ? recipient.email
      : undefined
  const email = limited(own ?? settings.fallbackEmail ?? '', C807Limits.EMAIL_MAX_LENGTH, 'e-mail')
  if (email === '') throw new CarrierRejectedError('C807 needs the e-mail of the recipient')
  const reference = limited(params.reference, C807Limits.REFERENCE_MAX_LENGTH, 'order number')
  const parcels = params.parcels.length > 0 ? params.parcels : [{}]
  const count = Math.max(1, params.packageCount)
  const line = [recipient.address.line1, recipient.address.line2].filter(Boolean).join(', ')
  return {
    orden: reference,
    nombre: limited(recipient.name, C807Limits.NAME_MAX_LENGTH, 'name of the recipient'),
    direccion: limited(line, C807Limits.ADDRESS_MAX_LENGTH, 'address'),
    telefono: formatPhoneList(recipient.phones),
    correo: email,
    tipo_servicio: type,
    ...(type === C807ServiceTypes.COD && params.cod
      ? { monto_cce: c807Amount(params.cod.amountCents) }
      : {}),
    departamento_id: asId(recipient.locationIds.departmentId, 'department'),
    municipio_id: asId(recipient.locationIds.municipalityId, 'municipality'),
    ...(params.notes === undefined || params.notes === ''
      ? {}
      : { indicaciones: limited(params.notes, C807Limits.NOTES_MAX_LENGTH, 'notes') }),
    detalle: Array.from({ length: count }, (_unused, index) => {
      const parcel = parcels[index] ?? parcels[0] ?? {}
      const weight =
        parcel.weightGrams === undefined ||
        !Number.isFinite(parcel.weightGrams) ||
        parcel.weightGrams <= 0
          ? C807Parcel.DEFAULT_WEIGHT
          : Math.max(
              Math.round((parcel.weightGrams / C807_GRAMS_PER_UNIT[settings.weightUnit]) * 1000) /
                1000,
              C807Parcel.MIN_WEIGHT
            )
      return {
        peso: weight,
        contenido: limited(
          `${C807Parcel.CONTENT_PREFIX} ${reference}`,
          C807Limits.CONTENT_MAX_LENGTH,
          'content'
        ),
        unidad_medida: settings.weightUnit,
        // Several packages are children of one guide: C807 tells them apart by this code
        ...(count > 1 ? { codigo: String(index + 1) } : {})
      }
    })
  }
}

// The request `set_registro`: a pickup (date and time, delivery type, site) and the guides inside it. `provisional` is left
// out: without it the guides are confirmed and the pickup is scheduled in the same call.
export function toC807Request(params: {
  pickupDate: string
  pickupFrom: string
  metadata: C807Metadata
  guides: readonly Record<string, unknown>[]
}): Record<string, unknown> {
  return {
    recolecta_fecha: `${params.pickupDate} ${params.pickupFrom}`,
    tipo_entrega: params.metadata.deliveryType,
    ...(params.metadata.site === undefined ? {} : { sede: params.metadata.site }),
    guias: params.guides
  }
}
