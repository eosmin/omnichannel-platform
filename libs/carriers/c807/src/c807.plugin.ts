import { timingSafeEqual } from 'node:crypto'

import { z } from 'zod'

import {
  CarrierCapability,
  CarrierId,
  type CarrierTokenCache,
  CarrierWebhookTrust,
  LabelFormat,
  MemoryCarrierTokenCache
} from '@platform/core/domain'
import {
  CarrierAuthError,
  type CarrierConnectInput,
  type CarrierConnectResult,
  type CarrierContext,
  type CarrierEvent,
  type CarrierHealth,
  type CarrierLabel,
  type CarrierLocation,
  type CarrierPlugin,
  CarrierRejectedError,
  CarrierUnavailableError,
  type ConnectField,
  type CreatePickupBatchParams,
  type FetchLabelParams,
  type LocationQuery,
  type PickupBatchEntry,
  PickupBatchOutcomes,
  type PickupBatchResult,
  type PickupDetails,
  type PickupGuide,
  type PickupRef,
  PluginTypes,
  type ShipmentRef,
  ShipmentCreationModes
} from '@platform/plugins/sdk'

import { C807Client, type C807Scope } from './c807-client'
import {
  C807_DEFAULT_SERVICE_CODE,
  C807ConnectFieldKeys,
  C807_STATUS_CATALOG,
  C807_WEBHOOK_SECRET_HEADER,
  C807Api,
  C807Limits
} from './c807-constants'
import {
  C807_DISPLAY_NAME,
  type C807Credentials,
  c807ConnectionSchema,
  type C807Metadata,
  c807MetadataSchema
} from './c807-credentials'
import { toC807Guide, toC807Request } from './c807-payloads'
import { toCarrierEvent } from './c807-status'

export const C807_VERSION = '1.0.0'

// What `set_registro` answers: the pickup ("recolecta") and a guide for each package, with the order number echoed back
const createdSchema = z.object({
  recolecta: z.string().min(1),
  guias: z.array(
    z.object({
      orden: z.string().nullable().optional(),
      codigo: z.union([z.string(), z.number()]).nullable().optional(),
      guia: z.string().min(1),
      seguimiento: z.string().nullable().optional()
    })
  )
})

const labelSchema = z.object({ pdf: z.string().min(1) })

const reportRowSchema = z.object({
  guia: z.string().min(1),
  orden: z.string().nullable().optional(),
  solicitud: z.string().nullable().optional(),
  seguimiento: z.string().nullable().optional()
})
// The report answers `{"lista": [...]}` (sandbox, 2026-11-14); the documentation shows a bare array, which is read too
const reportSchema = z
  .union([z.array(reportRowSchema), z.object({ lista: z.array(reportRowSchema) })])
  .transform(value => (Array.isArray(value) ? value : value.lista))

const historySchema = z.array(
  z.object({
    estatus: z.string().optional(),
    codigo: z.union([z.string(), z.number()]),
    observaciones: z.string().nullable().optional(),
    fecha: z.string(),
    // Not in the documented history rows; read when C807 sends them so that a return is never read as a delivery
    devolucion: z.boolean().optional(),
    razon: z
      .object({
        codigo: z.union([z.string(), z.number()]),
        descripcion: z.string().nullable().optional()
      })
      .optional()
  })
)

const catalogSchema = z.array(
  z.object({ id: z.union([z.string(), z.number()]), nombre: z.string() })
)

// The webhook sends one status as an object. `razon` is there for a code `16`, `devolucion` for a code `15`
const webhookSchema = z.object({
  guia: z.string().min(1),
  codigo: z.union([z.string(), z.number()]),
  estatus: z.string().optional(),
  fecha: z.string(),
  observaciones: z.string().nullable().optional(),
  devolucion: z.boolean().optional(),
  razon: z
    .object({
      codigo: z.union([z.string(), z.number()]),
      descripcion: z.string().nullable().optional()
    })
    .optional()
})

export const C807_CONNECT_FIELDS: readonly ConnectField[] = [
  {
    key: 'username',
    labelKey: C807ConnectFieldKeys.USERNAME,
    secret: false,
    required: true,
    multiple: false
  },
  {
    key: 'password',
    labelKey: C807ConnectFieldKeys.PASSWORD,
    secret: true,
    required: true,
    multiple: false
  },
  {
    key: 'deliveryType',
    labelKey: C807ConnectFieldKeys.DELIVERY_TYPE,
    helpKey: C807ConnectFieldKeys.DELIVERY_TYPE_HELP,
    secret: false,
    required: true,
    multiple: false
  },
  {
    key: 'fallbackEmail',
    labelKey: C807ConnectFieldKeys.FALLBACK_EMAIL,
    helpKey: C807ConnectFieldKeys.FALLBACK_EMAIL_HELP,
    secret: false,
    required: false,
    multiple: false
  },
  {
    key: 'weightUnit',
    labelKey: C807ConnectFieldKeys.WEIGHT_UNIT,
    helpKey: C807ConnectFieldKeys.WEIGHT_UNIT_HELP,
    secret: false,
    required: false,
    multiple: false
  },
  {
    key: 'environment',
    labelKey: C807ConnectFieldKeys.ENVIRONMENT,
    helpKey: C807ConnectFieldKeys.ENVIRONMENT_HELP,
    secret: false,
    required: false,
    multiple: false
  },
  {
    key: 'site',
    labelKey: C807ConnectFieldKeys.SITE,
    helpKey: C807ConnectFieldKeys.SITE_HELP,
    secret: false,
    required: false,
    multiple: false
  }
]

// Runs `work` over the items, at most `size` at a time
async function inGroups<T>(
  items: readonly T[],
  size: number,
  work: (item: T) => Promise<void>
): Promise<void> {
  for (let start = 0; start < items.length; start += size) {
    await Promise.all(items.slice(start, start + size).map(work))
  }
}

const text = (value: string | number | null | undefined): string =>
  value === null || value === undefined ? '' : String(value)

function sameSecret(received: string, secret: string): boolean {
  const a = Buffer.from(received)
  const b = Buffer.from(secret)
  return a.length === b.length && timingSafeEqual(a, b)
}

// C807 Express (TDD_17 §14). A guide is made inside a pickup (one call carries both), so the plugin is pickup-bound. The carrier
// exposes no way to cancel a guide, to change a pickup or to quote, and signs nothing it sends: the capabilities are exactly
// what its documentation confirms. Status comes by webhook with a header the owner sets in the portal, and is asked again by
// the history of a guide.
export class C807Plugin implements CarrierPlugin {
  readonly id = CarrierId.C807
  readonly name = C807_DISPLAY_NAME
  readonly version = C807_VERSION
  readonly author = 'platform'
  readonly type = PluginTypes.CARRIER
  readonly capabilities = [
    CarrierCapability.PICKUP_BOUND_GUIDES,
    CarrierCapability.COD,
    CarrierCapability.FETCH_STATUS,
    CarrierCapability.WEBHOOK_STATUS,
    CarrierCapability.REQUIRES_LOCATION_IDS
  ] as const
  readonly connectFields = C807_CONNECT_FIELDS
  readonly shipmentCreation = ShipmentCreationModes.PICKUP_BOUND
  readonly maxBatchSize = C807Limits.MAX_BATCH_SIZE
  // The secret is a header and not a signature: an event that closes money or the order is confirmed by asking (TDD_17 §4.9)
  readonly webhookTrust = CarrierWebhookTrust.SHARED_SECRET

  private readonly client: C807Client

  // The cache is what the apps share between the api and the worker; without one (a test, one process) the token is kept in
  // memory. It is a plain parameter: the runtime builds the plugin with a factory, so this library has no decorators
  constructor(cache?: CarrierTokenCache) {
    this.client = new C807Client(cache ?? new MemoryCarrierTokenCache())
  }

  serviceCatalog = (): ReturnType<CarrierPlugin['serviceCatalog']> => [
    { code: C807_DEFAULT_SERVICE_CODE, label: C807_DISPLAY_NAME, defaultForNextDay: false }
  ]

  statusCatalog = (): ReturnType<CarrierPlugin['statusCatalog']> =>
    C807_STATUS_CATALOG.map(entry => ({ ...entry }))

  async connect(input: CarrierConnectInput): Promise<CarrierConnectResult> {
    const parsed = c807ConnectionSchema.safeParse(input.credentials)
    if (!parsed.success) throw new CarrierRejectedError('The C807 data is not valid')
    const { username, password, deliveryType, site, environment, fallbackEmail, weightUnit } =
      parsed.data
    // The credentials are proved before the connection exists, in the environment the owner chose; no token is kept for a
    // connection that has no id yet
    await this.client.login({ storeId: input.storeId, environment }, { username, password })
    return {
      displayName: C807_DISPLAY_NAME,
      credentials: { username, password },
      metadata: {
        deliveryType,
        environment,
        weightUnit,
        ...(site === undefined ? {} : { site }),
        ...(fallbackEmail === undefined ? {} : { fallbackEmail })
      }
    }
  }

  async disconnect(ctx: CarrierContext): Promise<void> {
    await this.client.forget(this.scope(ctx))
  }

  async healthCheck(ctx: CarrierContext): Promise<CarrierHealth> {
    const checkedAt = new Date().toISOString()
    try {
      await this.client.login(this.scope(ctx), this.credentials(ctx))
      return { healthy: true, checkedAt }
    } catch (error) {
      if (error instanceof CarrierAuthError || error instanceof CarrierRejectedError) {
        return { healthy: false, checkedAt, error: 'The credentials were rejected' }
      }
      return { healthy: false, checkedAt, error: 'C807 did not answer' }
    }
  }

  async createShipmentsWithPickup(
    ctx: CarrierContext,
    params: CreatePickupBatchParams
  ): Promise<PickupBatchResult> {
    if (params.shipments.length > C807Limits.MAX_BATCH_SIZE) {
      throw new CarrierRejectedError(`A batch takes at most ${C807Limits.MAX_BATCH_SIZE} shipments`)
    }
    const metadata = this.metadata(ctx)
    // A shipment the carrier would refuse is refused alone, before the call, and the others go on (partial success is
    // normal, TDD_17 §4.5). The reference is compared trimmed, as it is sent, and a repeated one is not sent twice.
    const entries: (PickupBatchEntry | null)[] = params.shipments.map(() => null)
    const sent: { index: number; reference: string; guide: Record<string, unknown> }[] = []
    const seen = new Set<string>()
    params.shipments.forEach((shipment, index) => {
      const reference = shipment.reference.trim()
      try {
        if (seen.has(reference)) {
          throw new CarrierRejectedError('The order number is repeated in the batch')
        }
        seen.add(reference)
        sent.push({ index, reference, guide: toC807Guide(shipment, metadata) })
      } catch (error) {
        if (!(error instanceof CarrierRejectedError)) throw error
        entries[index] = { outcome: PickupBatchOutcomes.REJECTED, message: error.message }
      }
    })
    if (sent.length === 0) {
      const why = entries
        .flatMap(entry => (entry?.outcome === PickupBatchOutcomes.REJECTED ? [entry.message] : []))
        .slice(0, 3)
        .join('; ')
      throw new CarrierRejectedError(`C807 would refuse every shipment of the batch: ${why}`)
    }
    const answer = await this.client.call(this.scope(ctx), this.credentials(ctx), {
      method: 'POST',
      path: C807Api.CREATE_PATH,
      body: toC807Request({
        pickupDate: params.pickup.window.date,
        pickupFrom: params.pickup.window.from,
        metadata,
        guides: sent.map(item => item.guide)
      })
    })
    // A call that went through and answered with something unreadable may have made guides: the outcome is unknown
    const parsed = createdSchema.safeParse(answer)
    if (!parsed.success) throw new CarrierUnavailableError('C807 answered with an unexpected body')

    // The labels are asked for a few at a time: one request each would hold the call for as long as the batch is big, and all
    // at once would trip the rate limit of the carrier
    await inGroups(sent, C807Limits.LABEL_CONCURRENCY, async ({ index, reference }) => {
      const mine = parsed.data.guias
        .filter(guide => text(guide.orden) === reference)
        .sort((a, b) => a.guia.localeCompare(b.guia))
      const first = mine[0]
      if (!first) {
        entries[index] = {
          outcome: PickupBatchOutcomes.REJECTED,
          message: 'C807 did not make a guide for this order'
        }
        return
      }
      const label = await this.labelOf(
        ctx,
        mine.map(guide => guide.guia),
        params.shipments[index]?.labelFormat ?? LabelFormat.PDF_100X150
      )
      entries[index] = {
        outcome: PickupBatchOutcomes.CREATED,
        shipment: {
          guideNumber: first.guia,
          ...(first.seguimiento ? { trackingUrl: first.seguimiento } : {}),
          ...(label === null ? {} : { label })
        }
      }
    })
    const shipments = entries.filter((entry): entry is PickupBatchEntry => entry !== null)
    if (!shipments.some(entry => entry.outcome === PickupBatchOutcomes.CREATED)) {
      throw new CarrierRejectedError('C807 made no guide for the batch')
    }
    return { pickupRef: parsed.data.recolecta, shipments }
  }

  async fetchPickup(ctx: CarrierContext, ref: PickupRef): Promise<PickupDetails> {
    const answer = await this.client.call(this.scope(ctx), this.credentials(ctx), {
      method: 'GET',
      path: C807Api.REPORT_PATH,
      query: { solicitud: ref.pickupRef }
    })
    const rows = this.parse(reportSchema, answer)
    const shipments: PickupGuide[] = []
    for (const row of [...rows].sort((a, b) => a.guia.localeCompare(b.guia))) {
      const reference = text(row.orden)
      // The first guide of an order stands for it, as it did when the guide was made
      if (reference === '' || shipments.some(guide => guide.reference === reference)) continue
      shipments.push({
        reference,
        guideNumber: row.guia,
        ...(row.seguimiento ? { trackingUrl: row.seguimiento } : {})
      })
    }
    return { pickupRef: ref.pickupRef, shipments }
  }

  async fetchLabel(ctx: CarrierContext, params: FetchLabelParams): Promise<CarrierLabel> {
    const label = await this.labelOf(ctx, [params.guideNumber], params.format, true)
    if (label === null) throw new CarrierUnavailableError('C807 did not return the label')
    return label
  }

  // Every status of each guide, oldest first: the core applies the ones it has not, and asks the last to confirm a delivery
  async fetchStatus(ctx: CarrierContext, refs: ShipmentRef[]): Promise<CarrierEvent[]> {
    const events: CarrierEvent[] = []
    for (const ref of refs) {
      const guide = ref.guideNumber ?? (await this.guideOf(ctx, ref.reference))
      if (guide === null) continue
      const answer = await this.client.call(this.scope(ctx), this.credentials(ctx), {
        method: 'GET',
        path: C807Api.historyPath(guide)
      })
      for (const row of this.parse(historySchema, answer)) {
        const event = toCarrierEvent({
          guide,
          code: text(row.codigo),
          ...(row.estatus === undefined ? {} : { label: row.estatus }),
          ...(row.observaciones === undefined ? {} : { observations: row.observaciones }),
          date: row.fecha,
          ...(row.devolucion === undefined ? {} : { returned: row.devolucion }),
          ...(row.razon === undefined
            ? {}
            : { reason: text(row.razon.codigo), reasonText: row.razon.descripcion })
        })
        if (event) events.push(event)
      }
    }
    return events.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
  }

  async lookupLocations(ctx: CarrierContext, query: LocationQuery): Promise<CarrierLocation[]> {
    const answer = await this.client.call(this.scope(ctx), this.credentials(ctx), {
      method: 'GET',
      path: query.parentId === undefined ? C807Api.DEPARTMENTS_PATH : C807Api.MUNICIPALITIES_PATH,
      ...(query.parentId === undefined ? {} : { query: { departamento: query.parentId } })
    })
    const wanted = query.search?.trim().toLowerCase()
    return this.parse(catalogSchema, answer)
      .map(row => ({
        id: text(row.id),
        name: row.nombre.trim(),
        ...(query.parentId === undefined ? {} : { parentId: query.parentId })
      }))
      .filter(
        row => wanted === undefined || wanted === '' || row.name.toLowerCase().includes(wanted)
      )
  }

  // The carrier signs nothing: the call is ours when it carries the secret of the connection in the header the owner set
  validateWebhookSignature(
    _rawBody: string,
    headers: Record<string, string>,
    secret: string
  ): boolean {
    if (secret === '') return false
    const name = Object.keys(headers).find(key => key.toLowerCase() === C807_WEBHOOK_SECRET_HEADER)
    const received = name === undefined ? undefined : headers[name]
    return received !== undefined && sameSecret(received, secret)
  }

  // Pure: one status of one guide. What the carrier sends that is not a status is no event.
  handleWebhook(payload: unknown): Promise<CarrierEvent[]> {
    const parsed = webhookSchema.safeParse(payload)
    if (!parsed.success) return Promise.resolve([])
    const { guia, codigo, estatus, fecha, observaciones, devolucion, razon } = parsed.data
    const event = toCarrierEvent({
      guide: guia,
      code: text(codigo),
      ...(estatus === undefined ? {} : { label: estatus }),
      ...(observaciones === undefined ? {} : { observations: observaciones }),
      date: fecha,
      ...(devolucion === undefined ? {} : { returned: devolucion }),
      ...(razon === undefined ? {} : { reason: text(razon.codigo), reasonText: razon.descripcion })
    })
    return Promise.resolve(event ? [event] : [])
  }

  // The label of one or more guides as a PDF. After a guide was made a label that fails is not a failure of the guide: the
  // label can be asked for again (`fetchLabel`), so here it is left out.
  private async labelOf(
    ctx: CarrierContext,
    guides: readonly string[],
    format: CarrierLabel['format'],
    strict = false
  ): Promise<CarrierLabel | null> {
    try {
      const answer = await this.client.call(this.scope(ctx), this.credentials(ctx), {
        method: 'POST',
        path: C807Api.LABEL_PATH,
        body: { guias: guides }
      })
      const parsed = labelSchema.safeParse(answer)
      if (!parsed.success)
        throw new CarrierUnavailableError('C807 answered with an unexpected body')
      return {
        format,
        contentType: 'application/pdf',
        data: new Uint8Array(Buffer.from(parsed.data.pdf, 'base64'))
      }
    } catch (error) {
      if (strict) throw error
      return null
    }
  }

  private async guideOf(ctx: CarrierContext, reference: string): Promise<string | null> {
    const answer = await this.client.call(this.scope(ctx), this.credentials(ctx), {
      method: 'GET',
      path: C807Api.REPORT_PATH,
      query: { orden: reference }
    })
    const rows = this.parse(reportSchema, answer).sort((a, b) => a.guia.localeCompare(b.guia))
    return rows[0]?.guia ?? null
  }

  private parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
    const parsed = schema.safeParse(value)
    if (!parsed.success) throw new CarrierUnavailableError('C807 answered with an unexpected body')
    return parsed.data
  }

  private scope(ctx: CarrierContext): C807Scope {
    // Only the environment is read here: a call that needs no type of delivery (the places, the health) must not ask for one. A
    // connection that says an environment this plugin does not know is refused, never sent to production
    const environment = c807MetadataSchema.pick({ environment: true }).safeParse(ctx.metadata)
    if (!environment.success) {
      throw new CarrierRejectedError('The C807 connection has an unknown environment')
    }
    return {
      storeId: ctx.storeId,
      connectionId: ctx.connectionId,
      environment: environment.data.environment
    }
  }

  private credentials(ctx: CarrierContext): C807Credentials {
    const { username, password } = ctx.credentials
    if (typeof username !== 'string' || typeof password !== 'string') {
      throw new CarrierAuthError('The C807 connection has no user and password')
    }
    return { username, password }
  }

  private metadata(ctx: CarrierContext): C807Metadata {
    const parsed = c807MetadataSchema.safeParse(ctx.metadata)
    if (!parsed.success)
      throw new CarrierRejectedError('The C807 connection has no type of delivery')
    return parsed.data
  }
}
