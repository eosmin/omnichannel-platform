import { CarrierCapability, CarrierId, GuideRefundStatus } from '@platform/core/domain'
import {
  CarrierAuthError,
  type CarrierConnectInput,
  type ConnectField,
  type CarrierConnectResult,
  type CarrierContext,
  type CarrierEvent,
  type CarrierHealth,
  type CarrierLabel,
  type CarrierLocation,
  type CarrierPlugin,
  CarrierRejectedError,
  CarrierUnavailableError,
  type CancelShipmentParams,
  type CancelShipmentResult,
  type CreateShipmentParams,
  type CreateShipmentResult,
  type FetchLabelParams,
  type LocationQuery,
  type PickupParams,
  type PickupResult,
  PluginTypes,
  type ShipmentRef,
  ShipmentCreationModes
} from '@platform/plugins/sdk'

import { callForza, downloadForzaPdf, type FetchLike } from './forza-client'
import {
  type ForzaConfig,
  bankIsPartial,
  forzaConnectInputSchema,
  readForzaConfig,
  splitForzaConnection
} from './forza-connection'
import {
  FORZA_CARRIER_VERSION,
  FORZA_HOME_SERVICE_CODE,
  ForzaRateServices,
  FORZA_STATUS_CATALOG,
  ForzaConnectFieldKeys as Keys,
  ForzaMethods
} from './forza-constants'
import {
  buildCreateServiceParams,
  readCancelResult,
  readCreatedGuide,
  readLabelLink,
  readPickup,
  readProvinces,
  readTownships,
  readTrackEvents,
  splitGuide
} from './forza-mapping'

export interface ForzaPluginOptions {
  fetch?: FetchLike
  now?: () => Date
}

const field = (
  key: string,
  labelKey: string,
  options: { secret?: boolean; required?: boolean; helpKey?: string } = {}
): ConnectField => ({
  key,
  labelKey,
  ...(options.helpKey === undefined ? {} : { helpKey: options.helpKey }),
  secret: options.secret ?? false,
  required: options.required ?? true,
  multiple: false
})

// What the connect form asks for; the names are the keys of `forzaConnectInputSchema`
export const FORZA_CONNECT_FIELDS: readonly ConnectField[] = [
  field('codApp', Keys.COD_APP),
  field('secretKey', Keys.SECRET_KEY, { secret: true }),
  field('idClient', Keys.ID_CLIENT),
  field('country', Keys.COUNTRY, { helpKey: Keys.COUNTRY_HELP }),
  field('baseUrl', Keys.BASE_URL, { helpKey: Keys.BASE_URL_HELP }),
  field('codeOfReference', Keys.CODE_OF_REFERENCE, { helpKey: Keys.CODE_OF_REFERENCE_HELP }),
  field('originHeaderCodeTownship', Keys.ORIGIN_TOWNSHIP, { helpKey: Keys.ORIGIN_TOWNSHIP_HELP }),
  field('bankId', Keys.BANK_ID, { required: false, helpKey: Keys.BANK_HELP }),
  field('bankAccountName', Keys.BANK_ACCOUNT_NAME, { required: false }),
  field('bankAccountType', Keys.BANK_ACCOUNT_TYPE, { required: false }),
  field('bankAccountId', Keys.BANK_ACCOUNT_ID, { required: false, secret: true }),
  field('defaultWeightLbs', Keys.DEFAULT_WEIGHT, {
    required: false,
    helpKey: Keys.DEFAULT_WEIGHT_HELP
  }),
  field('pickupVehicleTypeId', Keys.VEHICLE_TYPE, {
    required: false,
    helpKey: Keys.VEHICLE_TYPE_HELP
  })
]

const ALL_LOCATIONS = '-1'

function configOf(ctx: CarrierContext): ForzaConfig {
  const config = readForzaConfig(ctx)
  if (config === null) throw new CarrierRejectedError('The Forza connection is not complete')
  return config
}

function parseGuide(guideNumber: string): { serie: string; number: number } {
  const guide = splitGuide(guideNumber)
  if (guide === null) throw new CarrierRejectedError('The guide number is not a Forza guide')
  return guide
}

const includes = (name: string, search: string | undefined): boolean =>
  search === undefined || name.toLowerCase().includes(search.trim().toLowerCase())

// Forza Delivery Express (Step 4.15). Only what the API documentation confirms is declared: guides with their cost
// of cash on delivery, cancelling a guide that is still "Solicitado", tracking, the geography catalog and the
// pickup request. The webhook, the change or cancel of a pickup, the return guide and an idempotent create are not
// confirmed by the documentation, so the manual path covers them (TDD_17 §14).
export function createForzaCarrierPlugin(options: ForzaPluginOptions = {}): CarrierPlugin {
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init))
  const now = options.now ?? ((): Date => new Date())

  const probe = async (config: ForzaConfig): Promise<void> => {
    await callForza(doFetch, config, ForzaMethods.LIST_PROVINCES, {
      HeaderCode: ALL_LOCATIONS,
      IdCountry: config.country
    })
  }

  return {
    id: CarrierId.FORZA,
    name: 'Forza Delivery Express',
    version: FORZA_CARRIER_VERSION,
    author: 'platform',
    type: PluginTypes.CARRIER,
    connectFields: FORZA_CONNECT_FIELDS,
    // Forza keeps a commission out of the cash it collects, and has one service to price (owner, 2026-11-14)
    feeSettings: {
      commission: true,
      rateServices: ForzaRateServices,
      rateServiceOf: () => FORZA_HOME_SERVICE_CODE
    },
    capabilities: [
      CarrierCapability.CREATE_SHIPMENT,
      CarrierCapability.CANCEL_SHIPMENT,
      CarrierCapability.FETCH_STATUS,
      CarrierCapability.REQUIRES_LOCATION_IDS,
      CarrierCapability.PICKUP_REQUEST,
      CarrierCapability.COD
    ],

    serviceCatalog: () => [
      { code: FORZA_HOME_SERVICE_CODE, label: 'Home delivery', defaultForNextDay: false }
    ],
    statusCatalog: () => FORZA_STATUS_CATALOG,

    // The credentials are tried with a read of the catalog before the connection is kept
    connect: async (input: CarrierConnectInput): Promise<CarrierConnectResult> => {
      const parsed = forzaConnectInputSchema.safeParse(input.credentials)
      if (!parsed.success || bankIsPartial(parsed.data)) {
        throw new CarrierRejectedError('The Forza data is not valid')
      }
      const { credentials, metadata } = splitForzaConnection(parsed.data)
      const config = readForzaConfig({ credentials, metadata })
      if (config === null) throw new CarrierRejectedError('The Forza data is not valid')
      await probe(config)
      return { displayName: `Forza ${parsed.data.country}`, credentials, metadata }
    },
    disconnect: () => Promise.resolve(),
    healthCheck: async (ctx: CarrierContext): Promise<CarrierHealth> => {
      const checkedAt = now().toISOString()
      try {
        await probe(configOf(ctx))
        return { healthy: true, checkedAt }
      } catch (error) {
        const message =
          error instanceof CarrierAuthError
            ? 'The credentials were rejected'
            : 'Forza could not be checked'
        return { healthy: false, checkedAt, error: message }
      }
    },

    shipmentCreation: ShipmentCreationModes.STANDALONE,
    // The documentation states no rate limit: the platform's default of three at a time applies

    createShipment: async (
      ctx: CarrierContext,
      params: CreateShipmentParams
    ): Promise<CreateShipmentResult> => {
      const config = configOf(ctx)
      const built = buildCreateServiceParams(config, params, now())
      if (!built.ok) throw new CarrierRejectedError(built.message)
      const answer = await callForza(doFetch, config, ForzaMethods.CREATE_SERVICE, built.value)
      const created = readCreatedGuide(answer.objectValue)
      // The call was accepted but its answer has no guide: a guide may exist, so the outcome is unknown
      if (created === null) throw new CarrierUnavailableError('Forza answered without a guide')
      // The label is read with `fetchLabel`: the answer holds only a link to it
      return { guideNumber: created.guideNumber }
    },

    cancelShipment: async (
      ctx: CarrierContext,
      params: CancelShipmentParams
    ): Promise<CancelShipmentResult> => {
      const config = configOf(ctx)
      const guide = parseGuide(params.guideNumber)
      const answer = await callForza(doFetch, config, ForzaMethods.CANCEL, {
        IdClient: config.idClient,
        CodApp: config.codApp,
        Guides: [{ Serie: guide.serie, Number: guide.number }]
      })
      const result = readCancelResult(answer.objectValue)
      // Only a guide in "Solicitado" can be cancelled: the others come back as a refusal with Forza's reason
      if (!result.done) throw new CarrierRejectedError(result.message)
      return { refundStatus: GuideRefundStatus.PENDING }
    },

    fetchLabel: async (ctx: CarrierContext, params: FetchLabelParams): Promise<CarrierLabel> => {
      const config = configOf(ctx)
      parseGuide(params.guideNumber)
      const answer = await callForza(doFetch, config, ForzaMethods.REPRINT, {
        GuideNumber: [{ Guides: params.guideNumber.trim().toUpperCase() }]
      })
      const link = readLabelLink(answer.objectValue)
      if (link === null) throw new CarrierRejectedError('Forza sent no label for the guide')
      const data = await downloadForzaPdf(doFetch, config, link)
      return { format: params.format, contentType: 'application/pdf', data }
    },

    // Forza tracks by guide: a shipment with no guide yet cannot be asked about
    fetchStatus: async (ctx: CarrierContext, refs: ShipmentRef[]): Promise<CarrierEvent[]> => {
      const config = configOf(ctx)
      const events: CarrierEvent[] = []
      for (const ref of refs) {
        const guide = ref.guideNumber === undefined ? null : splitGuide(ref.guideNumber)
        if (ref.guideNumber === undefined || guide === null) continue
        try {
          const answer = await callForza(doFetch, config, ForzaMethods.TRACK, {
            GuideSerie: guide.serie,
            GuideNumber: guide.number
          })
          events.push(...readTrackEvents(ref.guideNumber.trim().toUpperCase(), answer.trackOrder))
        } catch (error) {
          // Forza refuses this guide: the others of the batch still get their status. An outage or bad credentials stop the poll.
          if (!(error instanceof CarrierRejectedError)) throw error
        }
      }
      return events
    },

    // Departments (no parent) and the municipalities of one department; the id of a municipality is the code the
    // guide needs (`HeaderCodeTownship`)
    lookupLocations: async (
      ctx: CarrierContext,
      query: LocationQuery
    ): Promise<CarrierLocation[]> => {
      const config = configOf(ctx)
      if (query.parentId === undefined) {
        const answer = await callForza(doFetch, config, ForzaMethods.LIST_PROVINCES, {
          HeaderCode: ALL_LOCATIONS,
          IdCountry: config.country
        })
        return readProvinces(answer.objectValue).filter(item => includes(item.name, query.search))
      }
      const answer = await callForza(doFetch, config, ForzaMethods.LIST_TOWNSHIPS, {
        HeaderCodeTownship: ALL_LOCATIONS,
        HeaderCode: query.parentId,
        IdCountry: config.country
      })
      return readTownships(answer.objectValue, query.parentId).filter(item =>
        includes(item.name, query.search)
      )
    },

    requestPickup: async (ctx: CarrierContext, params: PickupParams): Promise<PickupResult> => {
      const config = configOf(ctx)
      const answer = await callForza(doFetch, config, ForzaMethods.REQUEST_PICKUP, {
        CodeOfReference: config.codeOfReference,
        StartDate: `${params.window.date} ${params.window.from}:00`,
        EndDate: `${params.window.date} ${params.window.to}:00`,
        QuantityOfPieces: params.packageCount,
        TypeVehicleId: config.pickupVehicleTypeId
      })
      const pickup = readPickup(answer.objectValue)
      if (!pickup.ok) throw new CarrierRejectedError(pickup.message)
      return {
        pickupRef: String(pickup.serviceId),
        window: params.window,
        packageCount: params.packageCount
      }
    }
  }
}

export const forzaCarrierPlugin: CarrierPlugin = createForzaCarrierPlugin()
