import { ShipmentStatus } from '@platform/core/domain'
import type { CarrierStatusDescriptor } from '@platform/plugins/sdk'

// What the Forza API v2.2 documentation confirms, and nothing more (TDD_17 §14). Every value here comes from the
// documentation; a value it does not state is not guessed.

export const FORZA_CARRIER_VERSION = '1.0.0'

// The methods of the PayLoad: `{ Method, Params }`
export const ForzaMethods = {
  LIST_PROVINCES: 'GetListProvincesByHeaderCode',
  LIST_TOWNSHIPS: 'GetListTownshipByHeaderCode',
  CREATE_SERVICE: 'GetServiceByHeaderCodeRequest',
  TRACK: 'GetTrackOrderDetail',
  CANCEL: 'SetCancelGuides',
  REPRINT: 'GetGuideReprintRequest',
  REQUEST_PICKUP: 'SetPickupServiceByIntegration'
} as const
export type ForzaMethod = (typeof ForzaMethods)[keyof typeof ForzaMethods]

// The endpoint of each method, under the connection's base URL (the documentation spells them in both cases)
export const ForzaPaths = {
  [ForzaMethods.LIST_PROVINCES]: '/ecommerce/GetListProvincesByHeaderCode',
  [ForzaMethods.LIST_TOWNSHIPS]: '/ecommerce/GetListTownshipByHeaderCode',
  [ForzaMethods.CREATE_SERVICE]: '/Ecommerce/GetServiceByHeaderCodeRequest',
  [ForzaMethods.TRACK]: '/Ecommerce/GetTrackOrderDetail',
  [ForzaMethods.CANCEL]: '/Ecommerce/SetCancelGuides',
  [ForzaMethods.REPRINT]: '/ecommerce/GetGuideReprintRequest',
  [ForzaMethods.REQUEST_PICKUP]: '/Ecommerce/SetPickupServiceByIntegration'
} as const satisfies Record<ForzaMethod, string>

// The labels of the connect fields, as the message keys the web app translates (`settings.carriers.connect.fields.forza.*`)
const FIELD_PREFIX = 'settings.carriers.connect.fields.forza'
export const ForzaConnectFieldKeys = {
  COD_APP: `${FIELD_PREFIX}.codApp`,
  SECRET_KEY: `${FIELD_PREFIX}.secretKey`,
  ID_CLIENT: `${FIELD_PREFIX}.idClient`,
  COUNTRY: `${FIELD_PREFIX}.country`,
  BASE_URL: `${FIELD_PREFIX}.baseUrl`,
  CODE_OF_REFERENCE: `${FIELD_PREFIX}.codeOfReference`,
  ORIGIN_TOWNSHIP: `${FIELD_PREFIX}.originHeaderCodeTownship`,
  BANK_ID: `${FIELD_PREFIX}.bankId`,
  BANK_ACCOUNT_NAME: `${FIELD_PREFIX}.bankAccountName`,
  BANK_ACCOUNT_TYPE: `${FIELD_PREFIX}.bankAccountType`,
  BANK_ACCOUNT_ID: `${FIELD_PREFIX}.bankAccountId`,
  DEFAULT_WEIGHT: `${FIELD_PREFIX}.defaultWeightLbs`,
  VEHICLE_TYPE: `${FIELD_PREFIX}.pickupVehicleTypeId`,
  COUNTRY_HELP: `${FIELD_PREFIX}.countryHelp`,
  BASE_URL_HELP: `${FIELD_PREFIX}.baseUrlHelp`,
  CODE_OF_REFERENCE_HELP: `${FIELD_PREFIX}.codeOfReferenceHelp`,
  ORIGIN_TOWNSHIP_HELP: `${FIELD_PREFIX}.originHeaderCodeTownshipHelp`,
  BANK_HELP: `${FIELD_PREFIX}.bankHelp`,
  DEFAULT_WEIGHT_HELP: `${FIELD_PREFIX}.defaultWeightLbsHelp`,
  VEHICLE_TYPE_HELP: `${FIELD_PREFIX}.pickupVehicleTypeIdHelp`
} as const

export const ForzaHeaders = { SIGNATURE: 'LauValue' } as const

// The `StatusCode` of an answer (the documentation's "catálogo de respuestas controladas")
export const ForzaStatusCodes = {
  SUCCESS: 200,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  CONFLICT: 409,
  PRECONDITION_FAILED: 412,
  SERVER_ERROR: 500
} as const

// `IdResult` inside the `ObjectValue` of a pickup request: the call was valid and the business rule said no
export const ForzaPickupResults = { OK: 200, REFUSED: 409 } as const

export const ForzaCountries = { GT: 'GT', HN: 'HN', SV: 'SV' } as const
export type ForzaCountry = (typeof ForzaCountries)[keyof typeof ForzaCountries]

// The currency of each country, from the documentation (GTQ, HNL; El Salvador USD)
export const ForzaCurrencies = {
  [ForzaCountries.GT]: 'GTQ',
  [ForzaCountries.HN]: 'HNL',
  [ForzaCountries.SV]: 'USD'
} as const satisfies Record<ForzaCountry, string>

// Guides carry the series `FD` before the number (`FD10931478`)
export const FORZA_GUIDE_PATTERN = /^([A-Za-z]{1,4})(\d{1,12})$/

// The single service the documentation describes: home delivery (`idDeliveryOption` 1, "DOMICILIO"). Whether it
// is a cash-on-delivery service is decided by the COD object of the request, not by a code.
export const FORZA_HOME_SERVICE_CODE = 'home'
export const ForzaDelivery = { OPTION_ID: '1', DESCRIPTION: 'DOMICILIO' } as const

// Pickup vehicles (`TypeVehicleId`): motorcycle, van, truck
export const ForzaVehicleTypes = { MOTORCYCLE: 1, VAN: 2, TRUCK: 3 } as const

export const ForzaLimits = {
  REQUEST_TIMEOUT_MS: 20_000,
  // The documentation's lengths
  NAME_MAX: 100,
  ADDRESS_MAX: 100,
  PHONE_MAX: 24,
  TICKET_MAX: 7,
  NOTE_MAX: 100,
  // A label comes back as a link to a PDF: nothing bigger than this is read
  LABEL_MAX_BYTES: 5 * 1024 * 1024,
  // An answer of the API is JSON of a few kilobytes; the catalogs of a country are the largest
  ANSWER_MAX_BYTES: 8 * 1024 * 1024,
  MESSAGE_MAX: 200,
  GRAMS_PER_POUND: 453.592,
  DEFAULT_WEIGHT_LBS: 1
} as const

export const PDF_MAGIC = '%PDF'

// The statuses the documentation explains (the webhook section names ids 2, 4, 5, 14, 21, 22, 25 and 45, and the
// tracking example shows 1 as "Solicitado"). The mapping is deliberately conservative: a status whose meaning for the
// order the documentation does not settle is `null` (no effect), and every other id is left out so that it lands in
// the owner's unmapped list. That the `stageId` of a tracking milestone is the same id as the webhook's
// `GuideStatusId` is not confirmed (Step 4.15).
export const FORZA_STATUS_CODES = {
  REQUESTED: '1',
  PICKED_UP: '2',
  EN_ROUTE: '4',
  DELIVERED: '5',
  RETURNED: '14',
  AT_EXPRESS_CENTER: '21',
  DELIVERED_AT_EXPRESS_CENTER: '22',
  COD_PAID: '25',
  INCIDENT: '45'
} as const

export const FORZA_STATUS_CATALOG: readonly CarrierStatusDescriptor[] = [
  { code: FORZA_STATUS_CODES.REQUESTED, label: 'Requested', defaultStatus: null },
  {
    code: FORZA_STATUS_CODES.PICKED_UP,
    label: 'Picked up',
    defaultStatus: ShipmentStatus.PICKED_UP
  },
  // "On its way to be delivered": it can also be a move between hubs, so it is not `OUT_FOR_DELIVERY`
  {
    code: FORZA_STATUS_CODES.EN_ROUTE,
    label: 'En route',
    defaultStatus: ShipmentStatus.IN_TRANSIT
  },
  {
    code: FORZA_STATUS_CODES.DELIVERED,
    label: 'Delivered',
    defaultStatus: ShipmentStatus.DELIVERED
  },
  {
    code: FORZA_STATUS_CODES.RETURNED,
    label: 'Returned to the sender',
    defaultStatus: ShipmentStatus.RETURNED
  },
  {
    code: FORZA_STATUS_CODES.AT_EXPRESS_CENTER,
    label: 'Received at an Express Center',
    defaultStatus: ShipmentStatus.IN_TRANSIT
  },
  // Delivered to an agency, not necessarily to the customer: the owner decides
  {
    code: FORZA_STATUS_CODES.DELIVERED_AT_EXPRESS_CENTER,
    label: 'Delivered at an Express Center',
    defaultStatus: null
  },
  // A deposit to the merchant, not a move of the package
  { code: FORZA_STATUS_CODES.COD_PAID, label: 'Cash on delivery paid', defaultStatus: null },
  {
    code: FORZA_STATUS_CODES.INCIDENT,
    label: 'Incident on the route (failed delivery)',
    defaultStatus: ShipmentStatus.FAILED_ATTEMPT
  }
]
