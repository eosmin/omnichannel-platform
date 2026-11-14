import type {
  BulkConfirmResult,
  BulkLabelJobView,
  CarrierConnectionView,
  LabelMergeView,
  OrderMessageOutcomeView,
  OrderSummaryView,
  PickupRequestView,
  ShipmentSummaryView
} from '@platform/api-client'
import { ClientPermissions, type Permission } from '@platform/core/auth'
import {
  BulkLabelJobStatus,
  BulkLabelLimits,
  BulkOrderOutcomes,
  CarrierCapability,
  CarrierConnectionStatus,
  OrderLimits,
  OrderMessageOutcomeStatus,
  OrderStatus,
  ShipmentStatus
} from '@platform/core/domain'

// The actions over the rows ticked on the orders page (Step 4.14) and the report each one leaves. Pure: what is offered
// depends on who may (permissions), what the carriers of the guides can do (capabilities, never a carrier's name) and the
// rows themselves; the server still judges every order, and what it refuses comes back in the report.

export { liveGuidesByOrder } from './order-guides'

// What this page reads of a connection of the store
export type BulkConnection = Pick<
  CarrierConnectionView,
  'id' | 'displayName' | 'status' | 'capabilities'
> & {
  // The carrier an order with none planned goes to (absent where a screen does not know it)
  isDefault?: boolean
}

// What a run of labels is asked with: the carrier it is pinned to and its places, or the places of each planned carrier
export interface BulkLabelsOptions {
  connectionId?: string
  locationIds?: BulkLocationIds
  locationsByConnection?: Record<string, BulkLocationIds>
}

// The department and municipality of the carrier's own list that a run of labels sends for every order it makes a guide of
export interface BulkLocationIds {
  departmentId: string
  municipalityId: string
}

// Compared with the text the api answers: a state is text on the wire, not one of our enums
const ACTIVE_CONNECTION: string = CarrierConnectionStatus.ACTIVE

// A connection that can make a guide by a request of its own or by the platform: the ones a run of labels can be pinned to. A
// disconnected one "no longer creates guides" (Settings → Carriers): it stays in the history, not in this list
export function canMakeGuides(connection: BulkConnection): boolean {
  if (connection.status !== ACTIVE_CONNECTION) return false
  return (
    connection.capabilities.includes(CarrierCapability.CREATE_SHIPMENT) ||
    connection.capabilities.includes(CarrierCapability.INTERNAL_GUIDE) ||
    connection.capabilities.includes(CarrierCapability.PICKUP_BOUND_GUIDES)
  )
}

// The connection whose places the run of labels must ask for, decided by what the carrier declares and never by its name: only the one
// the person pinned, and only when it declares that it needs them. With nothing pinned each order follows its own planned carrier, and
// pinning one for the person would move orders planned elsewhere; so `null`, and the selector is offered whenever a carrier needs places.
export function placesConnectionOf(
  connections: readonly BulkConnection[],
  chosenId: string
): BulkConnection | null {
  const target = connections.filter(canMakeGuides).find(connection => connection.id === chosenId)
  return target?.capabilities.includes(CarrierCapability.REQUIRES_LOCATION_IDS) === true
    ? target
    : null
}

// The connections whose places a run that follows each order's planned carrier must give: the carrier each selected order is planned for (the default one of the store when it has none), when it makes guides and declares that it needs places, once
// each and in the order they first appear. An order that already has a guide counts too: the run reuses a printable one, but a part of
// a split order or a guide that cannot be printed yet may still be asked of the carrier, and an extra selector costs less than a refusal. Decided by the declaration of the carrier, never by its name. A run pinned to a carrier
// gives its places through `placesConnectionOf` and this is empty.
export function plannedPlacesConnections(
  input: Pick<BulkInput, 'selectedIds' | 'rows' | 'connections'>,
  chosenId: string
): BulkConnection[] {
  if (chosenId !== '') return []
  const rows = new Map(input.rows.map(row => [row.id, row]))
  const fallback = input.connections.find(connection => connection.isDefault === true)
  const needed = new Map<string, BulkConnection>()
  for (const id of input.selectedIds) {
    const row = rows.get(id)
    if (row === undefined) continue
    const planned =
      row.carrierConnectionId === null
        ? fallback
        : input.connections.find(connection => connection.id === row.carrierConnectionId)
    if (
      planned !== undefined &&
      canMakeGuides(planned) &&
      planned.capabilities.includes(CarrierCapability.REQUIRES_LOCATION_IDS)
    ) {
      needed.set(planned.id, planned)
    }
  }
  return [...needed.values()]
}

// The selector that pins a run to a carrier shows when there is a choice to make, or when the only carrier needs places (and the
// person has no other way to give them)
export function offersCarrierChoice(connections: readonly BulkConnection[]): boolean {
  const pinnable = connections.filter(canMakeGuides)
  return (
    pinnable.length > 1 ||
    pinnable.some(connection =>
      connection.capabilities.includes(CarrierCapability.REQUIRES_LOCATION_IDS)
    )
  )
}

export const BulkActionKinds = {
  CONFIRM: 'confirm',
  SUMMARY: 'summary',
  LABELS: 'labels',
  PRINT: 'print',
  PICKUP: 'pickup'
} as const
export type BulkActionKind = (typeof BulkActionKinds)[keyof typeof BulkActionKinds]

// Why this page left an order out before asking the server: a rule of its own, drawn from its own texts
export const BulkSkipRules = {
  NOT_PENDING_CONFIRMATION: 'not_pending_confirmation',
  NO_GUIDE: 'no_guide',
  NOT_WAITING_FOR_PICKUP: 'not_waiting_for_pickup',
  PICKUP_NOT_OFFERED: 'pickup_not_offered'
} as const
export type BulkSkipRule = (typeof BulkSkipRules)[keyof typeof BulkSkipRules]

export const BulkOutcomes = {
  DONE: 'done',
  REUSED: 'reused',
  SKIPPED: 'skipped',
  FAILED: 'failed'
} as const
export type BulkOutcome = (typeof BulkOutcomes)[keyof typeof BulkOutcomes]

// One order of the report. `code` is a code of the api (`errors.<code>`), `rule` a rule of this page, `reason` a closed
// word of the server (why a label is not in the file, why a message did not go); each is drawn from its own texts.
export interface BulkReportEntry {
  orderId: string
  outcome: BulkOutcome
  code?: string
  rule?: BulkSkipRule
  reason?: string
}

export interface BulkReport {
  action: BulkActionKind
  entries: BulkReportEntry[]
  // The file of a run or a print, while its link is good
  download: { url: string; filename: string } | null
  // A print whose pages are not all one size: the screen warns before printing
  mixedSizes: boolean
}

export const NO_REPORT_FILE = null

// The reason of an order of a run the page stopped waiting for
export const BulkStillRunning = 'still_running'

// Compared with the text the api answers: a state is text on the wire, not one of our enums
const LABEL_CREATED: string = ShipmentStatus.LABEL_CREATED
const PENDING_CONFIRMATION: string = OrderStatus.PENDING_CONFIRMATION

const STILL_GOING: ReadonlySet<string> = new Set([
  BulkLabelJobStatus.QUEUED,
  BulkLabelJobStatus.RUNNING
])

export interface BulkInput {
  // The selection in the order it was made: the order of the pages of a merged file
  selectedIds: readonly string[]
  rows: readonly OrderSummaryView[]
  guides: ReadonlyMap<string, ShipmentSummaryView[]>
  connections: readonly BulkConnection[]
  can: (permission: Permission) => boolean
}

export interface BulkAvailability {
  confirm: boolean
  summary: boolean
  labels: boolean
  print: boolean
  pickup: boolean
  // The selection is longer than a run takes: nothing that is sent in one request is offered
  tooMany: boolean
}

function capabilitiesOf(
  connections: readonly BulkConnection[],
  connectionId: string
): readonly string[] {
  return connections.find(connection => connection.id === connectionId)?.capabilities ?? []
}

// A pickup is asked of a carrier that has an API for it and whose guides do not travel inside the pickup itself
function asksPickups(connections: readonly BulkConnection[], connectionId: string): boolean {
  const capabilities = capabilitiesOf(connections, connectionId)
  return (
    capabilities.includes(CarrierCapability.PICKUP_REQUEST) &&
    !capabilities.includes(CarrierCapability.PICKUP_BOUND_GUIDES)
  )
}

export function pickupTargets(input: BulkInput): ShipmentSummaryView[] {
  return input.selectedIds.flatMap(orderId =>
    (input.guides.get(orderId) ?? []).filter(
      guide =>
        guide.status === LABEL_CREATED &&
        guide.pickupId === null &&
        asksPickups(input.connections, guide.connectionId)
    )
  )
}

export function printTargets(input: BulkInput): ShipmentSummaryView[] {
  return input.selectedIds.flatMap(orderId =>
    (input.guides.get(orderId) ?? []).filter(guide => guide.hasLabel)
  )
}

export function pendingConfirmationIds(input: BulkInput): string[] {
  const status = new Map(input.rows.map(row => [row.id, row.status]))
  return input.selectedIds.filter(id => status.get(id) === PENDING_CONFIRMATION)
}

export function availabilityOf(input: BulkInput): BulkAvailability {
  const count = input.selectedIds.length
  const tooMany = count > Math.min(BulkLabelLimits.MAX_ORDERS, OrderLimits.BULK_CONFIRM_MAX)
  const shipping = input.can(ClientPermissions.SHIPPING_MANAGE)
  return {
    tooMany,
    confirm:
      count > 0 &&
      !tooMany &&
      input.can(ClientPermissions.ORDERS_CONFIRM) &&
      pendingConfirmationIds(input).length > 0,
    summary: count > 0 && !tooMany && input.can(ClientPermissions.ORDERS_SEND_MESSAGES),
    labels: count > 0 && !tooMany && shipping,
    print: count > 0 && !tooMany && shipping && printTargets(input).length > 0,
    pickup:
      count > 0 &&
      !tooMany &&
      input.can(ClientPermissions.SHIPPING_MANAGE_PICKUPS) &&
      pickupTargets(input).length > 0
  }
}

// "Mark as confirmed": the orders the server was asked about, and the ones this page did not send (not pending), which are
// reported too. The server's `failed` carry our code; nothing changed for them.
export function confirmReport(
  selectedIds: readonly string[],
  notSent: readonly string[],
  result: BulkConfirmResult
): BulkReport {
  const failed = new Map(result.failed.map(entry => [entry.id, entry.code]))
  const succeeded = new Set(result.succeeded)
  const skippedHere = new Set(notSent)
  return {
    action: BulkActionKinds.CONFIRM,
    download: NO_REPORT_FILE,
    mixedSizes: false,
    entries: selectedIds.map((orderId): BulkReportEntry => {
      if (skippedHere.has(orderId)) {
        return {
          orderId,
          outcome: BulkOutcomes.SKIPPED,
          rule: BulkSkipRules.NOT_PENDING_CONFIRMATION
        }
      }
      if (succeeded.has(orderId)) return { orderId, outcome: BulkOutcomes.DONE }
      const code = failed.get(orderId)
      // An id the server said nothing about is never reported as left out for a reason: it failed with none
      return code === undefined
        ? { orderId, outcome: BulkOutcomes.FAILED }
        : { orderId, outcome: BulkOutcomes.SKIPPED, code }
    })
  }
}

// What a run of labels made of each order. `created` and `reused` are successes; `skipped` is an order that did not qualify
// and `failed` one the carrier did not give a guide for (or whose label is not in the file).
export function labelsReport(job: BulkLabelJobView, selectedIds: readonly string[]): BulkReport {
  const byOrder = new Map((job.results ?? []).map(entry => [entry.orderId, entry]))
  const stillRunning = STILL_GOING.has(job.status)
  return {
    action: BulkActionKinds.LABELS,
    download: job.download,
    mixedSizes: false,
    entries: selectedIds.map((orderId): BulkReportEntry => {
      const entry = byOrder.get(orderId)
      if (entry === undefined) {
        // A run still going when the page stopped waiting: its orders are not failed, they are not known yet
        return {
          orderId,
          outcome: BulkOutcomes.FAILED,
          ...(stillRunning ? { reason: BulkStillRunning } : {})
        }
      }
      const outcome =
        entry.outcome === BulkOrderOutcomes.CREATED
          ? BulkOutcomes.DONE
          : entry.outcome === BulkOrderOutcomes.REUSED
            ? BulkOutcomes.REUSED
            : entry.outcome === BulkOrderOutcomes.SKIPPED
              ? BulkOutcomes.SKIPPED
              : BulkOutcomes.FAILED
      return { orderId, outcome, code: entry.errorCode, reason: entry.reason }
    })
  }
}

// "Print labels": no carrier is called. An order with no guide is left out here; a label the server left out names why.
export function printReport(
  selectedIds: readonly string[],
  targets: readonly ShipmentSummaryView[],
  merge: LabelMergeView
): BulkReport {
  const orderOf = new Map(targets.map(target => [target.id, target.orderId]))
  const leftOut = new Map<string, string>()
  for (const entry of merge.leftOut) {
    const orderId = orderOf.get(entry.shipmentId)
    if (orderId !== undefined && !leftOut.has(orderId)) leftOut.set(orderId, entry.reason)
  }
  const printed = new Set(merge.merged.map(id => orderOf.get(id)))
  const withGuide = new Set(targets.map(target => target.orderId))
  return {
    action: BulkActionKinds.PRINT,
    download: merge.download,
    mixedSizes: merge.mixedSizes,
    entries: selectedIds.map((orderId): BulkReportEntry => {
      if (!withGuide.has(orderId)) {
        return { orderId, outcome: BulkOutcomes.SKIPPED, rule: BulkSkipRules.NO_GUIDE }
      }
      const reason = leftOut.get(orderId)
      if (printed.has(orderId) && reason === undefined)
        return { orderId, outcome: BulkOutcomes.DONE }
      return { orderId, outcome: BulkOutcomes.SKIPPED, reason }
    })
  }
}

// One pickup request per connection: the guides that joined or made the pickup are done, the ones that wait say why, and a
// connection the api refused fails all its guides with the code
export interface PickupAttempt {
  connectionId: string
  shipmentIds: readonly string[]
  result: PickupRequestView | { code: string }
}

export function pickupReport(
  selectedIds: readonly string[],
  targets: readonly ShipmentSummaryView[],
  attempts: readonly PickupAttempt[]
): BulkReport {
  const orderOf = new Map(targets.map(target => [target.id, target.orderId]))
  const entries = new Map<string, BulkReportEntry>()
  const set = (shipmentId: string, entry: Omit<BulkReportEntry, 'orderId'>): void => {
    const orderId = orderOf.get(shipmentId)
    if (orderId === undefined) return
    // An order with two guides is done only when every guide is: a refusal is never hidden by a success
    const current = entries.get(orderId)
    if (current === undefined || current.outcome === BulkOutcomes.DONE) {
      entries.set(orderId, { orderId, ...entry })
    }
  }
  for (const attempt of attempts) {
    if ('code' in attempt.result) {
      for (const id of attempt.shipmentIds) {
        set(id, { outcome: BulkOutcomes.FAILED, code: attempt.result.code })
      }
      continue
    }
    const waiting = new Map(attempt.result.waiting.map(entry => [entry.shipmentId, entry.reason]))
    for (const id of attempt.shipmentIds) {
      const reason = waiting.get(id)
      set(
        id,
        reason === undefined
          ? { outcome: BulkOutcomes.DONE }
          : { outcome: BulkOutcomes.SKIPPED, reason }
      )
    }
  }
  const withTarget = new Set(targets.map(target => target.orderId))
  return {
    action: BulkActionKinds.PICKUP,
    download: NO_REPORT_FILE,
    mixedSizes: false,
    entries: selectedIds.map((orderId): BulkReportEntry => {
      const entry = entries.get(orderId)
      if (entry !== undefined) return entry
      return {
        orderId,
        outcome: BulkOutcomes.SKIPPED,
        rule: withTarget.has(orderId)
          ? BulkSkipRules.PICKUP_NOT_OFFERED
          : BulkSkipRules.NOT_WAITING_FOR_PICKUP
      }
    })
  }
}

// "Send the summary": one call per order, so an order whose call failed carries the code of the error
export type SummaryAttempt =
  { orderId: string; outcome: OrderMessageOutcomeView } | { orderId: string; code: string }

export function summaryReport(attempts: readonly SummaryAttempt[]): BulkReport {
  return {
    action: BulkActionKinds.SUMMARY,
    download: NO_REPORT_FILE,
    mixedSizes: false,
    entries: attempts.map((attempt): BulkReportEntry => {
      if ('code' in attempt) {
        return { orderId: attempt.orderId, outcome: BulkOutcomes.FAILED, code: attempt.code }
      }
      const { status, reason } = attempt.outcome
      if (
        status === OrderMessageOutcomeStatus.SENT ||
        status === OrderMessageOutcomeStatus.DUPLICATE
      ) {
        return { orderId: attempt.orderId, outcome: BulkOutcomes.DONE }
      }
      return {
        orderId: attempt.orderId,
        outcome: BulkOutcomes.SKIPPED,
        reason: reason ?? undefined
      }
    })
  }
}

export function reportCounts(report: BulkReport): Record<BulkOutcome, number> {
  const counts: Record<BulkOutcome, number> = { done: 0, reused: 0, skipped: 0, failed: 0 }
  for (const entry of report.entries) counts[entry.outcome] += 1
  return counts
}

// The orders that did not go through, in the order of the selection: the list the report puts first
export function leftOutEntries(report: BulkReport): BulkReportEntry[] {
  return report.entries.filter(
    entry => entry.outcome === BulkOutcomes.SKIPPED || entry.outcome === BulkOutcomes.FAILED
  )
}

// What a run reached while it is going: the share of the orders settled, 0 to 1
export function jobProgress(job: Pick<BulkLabelJobView, 'total' | 'succeeded' | 'failed'>): number {
  return job.total === 0 ? 0 : Math.min(1, (job.succeeded + job.failed) / job.total)
}
