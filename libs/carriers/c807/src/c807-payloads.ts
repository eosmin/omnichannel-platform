import { formatPhoneList, ShippingPayer } from '@platform/core/domain'
import { CarrierRejectedError, type CreateShipmentParams } from '@platform/plugins/sdk'

import { C807Limits, C807Parcel, C807ServiceTypes } from './c807-constants'
import type { C807Metadata } from './c807-credentials'

export type C807ServiceType = (typeof C807ServiceTypes)[keyof typeof C807ServiceTypes]

// The type of service follows the guide (the owner decided it, 2026-11-13):
//   product collected, carrier paid by the sender      -> CCE with the amount of the product
//   product already paid, carrier paid by the recipient -> SEC (the carrier collects its own fee)
//   nothing to collect, carrier paid by the sender      -> SER (an order paid in full, an exchange of total 0)
// A product to collect together with a fee the recipient pays is a case C807 does not document, so it is refused and not guessed
// (it waits for the answer of the advisor, Step 4.15).
export function c807ServiceTypeOf(
  params: Pick<CreateShipmentParams, 'cod' | 'shippingPayer'>
): C807ServiceType {
  const recipientPays = params.shippingPayer === ShippingPayer.RECIPIENT
  if (params.cod !== null) {
    if (recipientPays) {
      throw new CarrierRejectedError(
        'C807 does not take a cash on delivery order whose shipping the recipient also pays'
      )
    }
    return C807ServiceTypes.COD
  }
  return recipientPays ? C807ServiceTypes.RECIPIENT_PAYS : C807ServiceTypes.STANDARD
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
export function toC807Guide(params: CreateShipmentParams): Record<string, unknown> {
  const { recipient } = params
  if (!recipient.locationIds)
    throw new CarrierRejectedError('The delivery place of C807 is missing')
  const type = c807ServiceTypeOf(params)
  const reference = limited(params.reference, C807Limits.REFERENCE_MAX_LENGTH, 'order number')
  const parcels = params.parcels.length > 0 ? params.parcels : [{}]
  const count = Math.max(1, params.packageCount)
  const line = [recipient.address.line1, recipient.address.line2].filter(Boolean).join(', ')
  return {
    orden: reference,
    nombre: limited(recipient.name, C807Limits.NAME_MAX_LENGTH, 'name of the recipient'),
    direccion: limited(line, C807Limits.ADDRESS_MAX_LENGTH, 'address'),
    telefono: formatPhoneList(recipient.phones),
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
      const kilos =
        parcel.weightGrams === undefined
          ? C807Parcel.DEFAULT_WEIGHT_KG
          : Math.max(parcel.weightGrams / C807Parcel.GRAMS_PER_KG, 0.001)
      return {
        peso: kilos,
        contenido: limited(
          `${C807Parcel.CONTENT_PREFIX} ${reference}`,
          C807Limits.CONTENT_MAX_LENGTH,
          'content'
        ),
        unidad_medida: C807Parcel.WEIGHT_UNIT,
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
