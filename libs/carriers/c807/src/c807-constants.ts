import { ShipmentStatus } from '@platform/core/domain'

// What C807 Express documents (Google Sites "Xpress"); nothing here is a guess except what its comment says.
export const C807Api = {
  BASE_URL: 'https://app.c807.com',
  TOKEN_PATH: '/admin.php/sesion/get_token',
  DEPARTMENTS_PATH: '/guia.php/catalogo/departamento',
  MUNICIPALITIES_PATH: '/guia.php/catalogo/municipio',
  CREATE_PATH: '/guia.php/api/set_registro',
  LABEL_PATH: '/guia.php/api/get_pdf',
  REPORT_PATH: '/guia.php/reporte/guias',
  historyPath: (guideNumber: string): string =>
    `/guia.php/api/get_historia/${encodeURIComponent(guideNumber)}`,
  // A call that takes longer is an unknown outcome, never a slow success
  TIMEOUT_MS: 20_000
} as const

// The token lives 24 hours; it is kept a little less so that a call never leaves with one that expires on the way
export const C807Token = { TTL_SECONDS: 23 * 60 * 60 } as const

// `tipo_servicio`. Chosen from the guide, never typed: COD collects the product, SEC makes the recipient pay the carrier's
// fee (the product is already paid), SER collects nothing
export const C807ServiceTypes = { STANDARD: 'SER', COD: 'CCE', RECIPIENT_PAYS: 'SEC' } as const

// The labels of the connect fields, as the message keys the web app translates (`settings.carriers.connect.fields.c807.*`)
export const C807ConnectFieldKeys = {
  USERNAME: 'settings.carriers.connect.fields.c807.username',
  PASSWORD: 'settings.carriers.connect.fields.c807.password',
  DELIVERY_TYPE: 'settings.carriers.connect.fields.c807.deliveryType',
  SITE: 'settings.carriers.connect.fields.c807.site',
  DELIVERY_TYPE_HELP: 'settings.carriers.connect.fields.c807.deliveryTypeHelp',
  SITE_HELP: 'settings.carriers.connect.fields.c807.siteHelp'
} as const

// The single service of the catalog: the type of the guide follows the order, and `tipo_entrega` is a setting of the connection
export const C807_DEFAULT_SERVICE_CODE = 'standard'

// Limits of the documentation that the plugin checks before it calls, so that the refusal names the cause
export const C807Limits = {
  // `orden`, the reference of the order the carrier echoes back
  REFERENCE_MAX_LENGTH: 25,
  ADDRESS_MAX_LENGTH: 250,
  NAME_MAX_LENGTH: 75,
  NOTES_MAX_LENGTH: 500,
  CONTENT_MAX_LENGTH: 500,
  // Not documented: a conservative size for one request
  MAX_BATCH_SIZE: 25,
  // How many labels are asked for at the same time
  LABEL_CONCURRENCY: 5
} as const

// `peso` is required and a parcel may have none recorded: a package that weighs one kilogram is the smallest honest guess
export const C807Parcel = {
  WEIGHT_UNIT: 'KG',
  DEFAULT_WEIGHT_KG: 1,
  GRAMS_PER_KG: 1000,
  CONTENT_PREFIX: 'Pedido'
} as const

// Dates arrive as "2022-02-17 12:16:35" with no zone. C807 works in Central America (UTC-6, no daylight saving).
// To be confirmed with the sandbox (Step 4.15).
export const C807Time = { OFFSET: '-06:00' } as const

// The header the owner pastes in the portal of C807 (section Webhook, "Encabezado") with the secret of the connection.
// The carrier signs nothing, so this header is all that says the call is ours (TDD_17 §4.9)
export const C807_WEBHOOK_SECRET_HEADER = 'x-webhook-secret'

// The status codes of C807 and what each is assumed to mean. `null` is a code the plugin does not dare to assume: it waits in the
// unmapped list for the owner. A code with a reason is the composite `code:reason` the owner can map alone (TDD_17 §4.17).
export const C807StatusCodes = {
  ENTERED: '10',
  ASSIGNED_TO_VEHICLE: '11',
  PICKED_UP: '13',
  ON_THE_WAY: '14',
  ARRIVED: '15',
  PROBLEM: '16',
  IN_WAREHOUSE: '19',
  HELD_IN_WAREHOUSE: '20',
  MOVED_TO_WAREHOUSE: '21'
} as const

// The reason of `15` when the package went back to the sender instead of reaching the customer (confirmed by C807)
export const C807_RETURN_REASON = 'devolucion'

export interface C807StatusEntry {
  code: string
  label: string
  defaultStatus: ShipmentStatus | null
}

// Codes `100` to `132` of the "problems in the management" status, from the list C807 sent. Their detail is not sent by
// the webhook of the history, only by the tracking page.
const PROBLEM_REASONS: readonly (readonly [string, string, ShipmentStatus | null])[] = [
  ['100', 'Out of coverage', ShipmentStatus.FAILED_ATTEMPT],
  ['101', 'Package lost', null],
  ['102', 'Vehicle breakdown', ShipmentStatus.FAILED_ATTEMPT],
  ['103', 'Price difference', ShipmentStatus.FAILED_ATTEMPT],
  ['104', 'Street closed', ShipmentStatus.FAILED_ATTEMPT],
  ['105', 'Rescheduled', ShipmentStatus.FAILED_ATTEMPT],
  ['106', 'Wrong documentation', ShipmentStatus.FAILED_ATTEMPT],
  ['107', 'Accident', null],
  ['108', 'Change of address', ShipmentStatus.FAILED_ATTEMPT],
  ['109', 'House or business closed', ShipmentStatus.FAILED_ATTEMPT],
  ['110', 'Return', ShipmentStatus.RETURNING],
  ['111', 'Recipient has no cash', ShipmentStatus.FAILED_ATTEMPT],
  ['112', 'Customer rejects the shipment', ShipmentStatus.RETURNING],
  ['113', 'Holiday', ShipmentStatus.FAILED_ATTEMPT],
  ['114', 'Incident on the route', null],
  ['115', 'Incomplete address or no answer', ShipmentStatus.FAILED_ATTEMPT],
  ['116', 'Demonstration', ShipmentStatus.FAILED_ATTEMPT],
  ['117', 'Waited more than 10 minutes', ShipmentStatus.FAILED_ATTEMPT],
  ['118', 'Hard to reach area', ShipmentStatus.FAILED_ATTEMPT],
  ['119', 'Recipient unknown', ShipmentStatus.FAILED_ATTEMPT],
  ['120', 'Wrong phone number', ShipmentStatus.FAILED_ATTEMPT],
  ['121', 'Shipment damaged', null],
  ['122', 'Meeting point, no answer', ShipmentStatus.FAILED_ATTEMPT],
  ['123', 'Police check', ShipmentStatus.FAILED_ATTEMPT],
  ['124', 'Shipment crossed', null],
  ['125', 'Theft', null],
  ['126', 'Security does not allow entry', ShipmentStatus.FAILED_ATTEMPT],
  ['127', 'Out of time', ShipmentStatus.FAILED_ATTEMPT],
  ['128', 'Red zone', ShipmentStatus.FAILED_ATTEMPT],
  ['129', 'Street closed by a disaster', ShipmentStatus.FAILED_ATTEMPT],
  ['130', 'Minor at home', ShipmentStatus.FAILED_ATTEMPT],
  ['131', 'Bad weather', ShipmentStatus.FAILED_ATTEMPT],
  ['132', 'No packages', ShipmentStatus.FAILED_ATTEMPT]
]

export const C807_STATUS_CATALOG: readonly C807StatusEntry[] = [
  {
    code: C807StatusCodes.ENTERED,
    label: 'Entered into the system',
    defaultStatus: ShipmentStatus.LABEL_CREATED
  },
  {
    code: C807StatusCodes.ASSIGNED_TO_VEHICLE,
    label: 'Assigned to a vehicle',
    defaultStatus: ShipmentStatus.OUT_FOR_DELIVERY
  },
  {
    code: C807StatusCodes.PICKED_UP,
    label: 'Picked up at the origin',
    defaultStatus: ShipmentStatus.PICKED_UP
  },
  {
    code: C807StatusCodes.ON_THE_WAY,
    label: 'On the way to the destination',
    defaultStatus: ShipmentStatus.OUT_FOR_DELIVERY
  },
  {
    code: C807StatusCodes.ARRIVED,
    label: 'Arrived at the destination',
    defaultStatus: ShipmentStatus.DELIVERED
  },
  {
    code: `${C807StatusCodes.ARRIVED}:${C807_RETURN_REASON}`,
    label: 'Arrived at the destination: returned to the sender',
    defaultStatus: ShipmentStatus.RETURNED
  },
  {
    code: C807StatusCodes.PROBLEM,
    label: 'Problems in the management',
    defaultStatus: ShipmentStatus.FAILED_ATTEMPT
  },
  ...PROBLEM_REASONS.map(([reason, label, defaultStatus]) => ({
    code: `${C807StatusCodes.PROBLEM}:${reason}`,
    label: `Problems in the management: ${label}`,
    defaultStatus
  })),
  {
    code: C807StatusCodes.IN_WAREHOUSE,
    label: 'Entered into a warehouse',
    defaultStatus: ShipmentStatus.IN_TRANSIT
  },
  {
    code: C807StatusCodes.HELD_IN_WAREHOUSE,
    label: 'Held in a warehouse',
    defaultStatus: ShipmentStatus.IN_TRANSIT
  },
  {
    code: C807StatusCodes.MOVED_TO_WAREHOUSE,
    label: 'Moved to a warehouse',
    defaultStatus: ShipmentStatus.IN_TRANSIT
  }
]
