import type { OrderListFilter } from '@platform/api-client'
import {
  OrderListFilters,
  OrderScheduleFilters,
  OrderScheduledDeliveryShortcuts,
  OrderSorts,
  OrderStatus,
  PaymentStatus
} from '@platform/core/domain'

// The filters of the orders page and the address that holds them. The names are the keys of the query of the api
// (OrderListFilters, OrderScheduleFilters), so what is in the address is what the list asks and what the export takes.
// An address written by hand or kept in an old bookmark can hold anything: what does not fit is left out, never sent.

const DAY = /^\d{4}-\d{2}-\d{2}$/
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const STATUSES: ReadonlySet<string> = new Set(Object.values(OrderStatus))
const PAYMENT_STATUSES: ReadonlySet<string> = new Set(Object.values(PaymentStatus))
const SHORTCUTS: ReadonlySet<string> = new Set(Object.values(OrderScheduledDeliveryShortcuts))
const SORTS: ReadonlySet<string> = new Set(Object.values(OrderSorts))

export interface OrderListState {
  filter: OrderListFilter
  sort: string
}

export const DEFAULT_ORDER_SORT = OrderSorts.NEWEST

// Every key the page owns in the address: the others (a future one of the shell) are left alone
export const ORDER_PARAMS: readonly string[] = [
  OrderListFilters.Q,
  OrderListFilters.STATUS,
  OrderListFilters.PAYMENT_STATUS,
  OrderListFilters.CUSTOMER_ID,
  OrderListFilters.CREATED_FROM,
  OrderListFilters.CREATED_TO,
  OrderListFilters.SORT,
  OrderScheduleFilters.FROM,
  OrderScheduleFilters.TO,
  OrderScheduleFilters.ON
]

function day(value: string | null): string | undefined {
  if (value === null || !DAY.test(value)) return undefined
  // A day that does not exist ('2026-02-30') rolls into the next month: the round trip tells it
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
    ? value
    : undefined
}

export function stateFromParams(params: Pick<URLSearchParams, 'get'>): OrderListState {
  const q = params.get(OrderListFilters.Q)?.trim()
  const status = params.get(OrderListFilters.STATUS)
  const paymentStatus = params.get(OrderListFilters.PAYMENT_STATUS)
  const customerId = params.get(OrderListFilters.CUSTOMER_ID)
  const on = params.get(OrderScheduleFilters.ON)
  const sort = params.get(OrderListFilters.SORT)
  const scheduledFrom = day(params.get(OrderScheduleFilters.FROM))
  const scheduledTo = day(params.get(OrderScheduleFilters.TO))
  const createdFrom = day(params.get(OrderListFilters.CREATED_FROM))
  const createdTo = day(params.get(OrderListFilters.CREATED_TO))
  // A shortcut and days at once is a 422 from the api: the shortcut wins, as it is the one a person clicks
  const shortcut = on !== null && SHORTCUTS.has(on) ? on : undefined
  const filter: OrderListFilter = {
    ...(q === undefined || q === '' ? {} : { q }),
    ...(status !== null && STATUSES.has(status) ? { status } : {}),
    ...(paymentStatus !== null && PAYMENT_STATUSES.has(paymentStatus) ? { paymentStatus } : {}),
    ...(customerId !== null && ID.test(customerId) ? { customerId: customerId.toLowerCase() } : {}),
    ...(createdFrom === undefined ? {} : { createdFrom }),
    ...(createdTo === undefined ? {} : { createdTo }),
    ...(shortcut === undefined
      ? {
          ...(scheduledFrom === undefined ? {} : { scheduledDeliveryFrom: scheduledFrom }),
          ...(scheduledTo === undefined ? {} : { scheduledDeliveryTo: scheduledTo })
        }
      : { scheduledDeliveryOn: shortcut })
  }
  return {
    filter: dropInvertedRanges(filter),
    sort: sort !== null && SORTS.has(sort) ? sort : DEFAULT_ORDER_SORT
  }
}

// A first day after the last is a 422 too: the page shows the list unfiltered by that range instead of an error
function dropInvertedRanges(filter: OrderListFilter): OrderListFilter {
  const next = { ...filter }
  if (
    next.createdFrom !== undefined &&
    next.createdTo !== undefined &&
    next.createdFrom > next.createdTo
  ) {
    delete next.createdFrom
    delete next.createdTo
  }
  if (
    next.scheduledDeliveryFrom !== undefined &&
    next.scheduledDeliveryTo !== undefined &&
    next.scheduledDeliveryFrom > next.scheduledDeliveryTo
  ) {
    delete next.scheduledDeliveryFrom
    delete next.scheduledDeliveryTo
  }
  return next
}

// The pairs the address holds for a state; the default sort and an empty filter write nothing
export function paramsFromState(state: OrderListState): [string, string][] {
  const { filter } = state
  const entries: [string, string | undefined][] = [
    [OrderListFilters.Q, filter.q],
    [OrderListFilters.STATUS, filter.status],
    [OrderListFilters.PAYMENT_STATUS, filter.paymentStatus],
    [OrderListFilters.CUSTOMER_ID, filter.customerId],
    [OrderListFilters.CREATED_FROM, filter.createdFrom],
    [OrderListFilters.CREATED_TO, filter.createdTo],
    [OrderScheduleFilters.FROM, filter.scheduledDeliveryFrom],
    [OrderScheduleFilters.TO, filter.scheduledDeliveryTo],
    [OrderScheduleFilters.ON, filter.scheduledDeliveryOn],
    [OrderListFilters.SORT, state.sort === DEFAULT_ORDER_SORT ? undefined : state.sort]
  ]
  return entries.filter(
    (entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== ''
  )
}

// The filters that narrow the list (the sort does not): what "clear filters" removes and the count says
export function activeFilterCount(filter: OrderListFilter): number {
  return Object.values(filter).filter(value => value !== undefined && value !== '').length
}

const SCHEDULE_KEYS = [
  'scheduledDeliveryFrom',
  'scheduledDeliveryTo',
  'scheduledDeliveryOn'
] as const

function withoutSchedule(filter: OrderListFilter): OrderListFilter {
  const next = { ...filter }
  for (const key of SCHEDULE_KEYS) delete next[key]
  return next
}

// Picking a shortcut drops the days of the schedule, and typing a day drops the shortcut: they are never sent together
export function withScheduledShortcut(
  filter: OrderListFilter,
  shortcut: string | undefined
): OrderListFilter {
  const rest = withoutSchedule(filter)
  return shortcut === undefined ? rest : { ...rest, scheduledDeliveryOn: shortcut }
}

export function withScheduledDays(
  filter: OrderListFilter,
  days: { from?: string; to?: string }
): OrderListFilter {
  return {
    ...withoutSchedule(filter),
    ...(days.from === undefined || days.from === '' ? {} : { scheduledDeliveryFrom: days.from }),
    ...(days.to === undefined || days.to === '' ? {} : { scheduledDeliveryTo: days.to })
  }
}
