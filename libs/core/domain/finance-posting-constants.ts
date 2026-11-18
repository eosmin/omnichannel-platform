import { FinanceSourceType } from './finance-constants'

// The automatic entries (TDD_18 §4.2, §6.1), Step 4B.6a. Constants only: the pure rules are in `libs/core/finance`.

// Which event of a source an entry is for. The same source posts one entry per kind (an order posts its payment, its
// shipment and its sale), so a failure and a key are per (source, kind).
export enum FinanceEventKind {
  // E1: an order paid before delivery
  PAYMENT = 'payment',
  // E2: the goods left the warehouse
  SENT = 'sent',
  // E3: the sale is recognized
  SALE = 'sale',
  // E4: a delivered guide, what the carrier charges for it
  CHARGES = 'charges',
  // E5: a remittance was confirmed
  REMITTANCE_CONFIRM = 'remittance_confirm',
  // E6: a confirmed remittance was voided
  REMITTANCE_VOID = 'remittance_void',
  // E7: the difference of a guide that did not match its remittance, written off by a person
  COD_WRITE_OFF = 'cod_write_off',
  // E8: a return was received
  RETURN_RESTOCK = 'return_restock',
  // E8: an order returned as a whole, with no return row (a parcel that came back, or a delivered order put back by an agent)
  ORDER_RETURN = 'order_return',
  // E14: the refund a person paid out when a return was completed (the money left, the customer's advance is settled)
  RETURN_REFUND = 'return_refund',
  // E9: a stock adjustment, a count variance or a transfer write-off
  ADJUST = 'adjust'
}

// The kind of source each event reads: a job that pairs another kind with an event has nothing to post (the job's schema is not
// enough, it only checks that both exist)
export const FinanceEventSource: Readonly<Record<FinanceEventKind, FinanceSourceType>> = {
  [FinanceEventKind.PAYMENT]: FinanceSourceType.ORDER,
  [FinanceEventKind.SENT]: FinanceSourceType.ORDER,
  [FinanceEventKind.SALE]: FinanceSourceType.ORDER,
  [FinanceEventKind.CHARGES]: FinanceSourceType.SHIPMENT,
  [FinanceEventKind.REMITTANCE_CONFIRM]: FinanceSourceType.REMITTANCE,
  [FinanceEventKind.REMITTANCE_VOID]: FinanceSourceType.REMITTANCE,
  [FinanceEventKind.COD_WRITE_OFF]: FinanceSourceType.SHIPMENT,
  [FinanceEventKind.RETURN_RESTOCK]: FinanceSourceType.RETURN,
  [FinanceEventKind.ORDER_RETURN]: FinanceSourceType.ORDER,
  [FinanceEventKind.RETURN_REFUND]: FinanceSourceType.RETURN,
  [FinanceEventKind.ADJUST]: FinanceSourceType.INVENTORY_MOVEMENT
}

// What the job does with a source whose date is before `accountingStartDate` or whose event has nothing to post
export enum FinancePostingOutcome {
  POSTED = 'posted',
  REPLAYED = 'replayed',
  // Before the accounting start date: never posted and never "unposted" (TDD_18 §6.5)
  BEFORE_START = 'before_start',
  // The event has no entry (an order cancelled before it existed, a transfer, a movement of a kind that posts nothing)
  NOTHING_TO_POST = 'nothing_to_post',
  FAILED = 'failed',
  // Only for a dry run (the sweep asks what an event WOULD do): the entry would be written, nothing was
  PENDING = 'pending'
}

// The two ends of the key of the sale of an order, for a query that must find every sale entry at once (the VAT report)
export const FinanceSaleKeyParts = { PREFIX: 'order:', SUFFIX: ':sale' } as const

// The idempotency key of the entry each event posts (TDD_18 §4.1)
export const FinancePostingKey = {
  ORDER_PAYMENT: (orderId: string): string => `order:${orderId}:payment`,
  ORDER_SENT: (orderId: string): string => `order:${orderId}:sent`,
  ORDER_SALE: (orderId: string): string =>
    `${FinanceSaleKeyParts.PREFIX}${orderId}${FinanceSaleKeyParts.SUFFIX}`,
  SHIPMENT_CHARGES: (shipmentId: string): string => `shipment:${shipmentId}:charges`,
  REMITTANCE_CONFIRM: (remittanceId: string): string => `remittance:${remittanceId}:confirm`,
  REMITTANCE_VOID: (remittanceId: string): string => `remittance:${remittanceId}:void`,
  SHIPMENT_WRITE_OFF: (shipmentId: string): string => `shipment:${shipmentId}:write_off`,
  RETURN_RESTOCK: (returnId: string): string => `return:${returnId}:restock`,
  ORDER_RETURN: (orderId: string): string => `order:${orderId}:return`,
  RETURN_REFUND: (returnId: string): string => `return:${returnId}:refund`,
  MOVEMENT_ADJUST: (movementId: string): string => `movement:${movementId}:adjust`
} as const

// The daily sweep of the books (TDD_18 §6.1)
export const FinanceSweepLimits = {
  // Sources one run looks at and queues: the oldest first, so a backlog (the first run after the machinery was deployed) drains over
  // the days instead of in one transaction-heavy night
  MAX_CANDIDATES_PER_RUN: 500,
  // Organizations one page of the scheduler reads
  ORGANIZATIONS_PAGE_SIZE: 200,
  // Accounts-and-periods whose balance one run recomputes in one statement
  BALANCE_PAGE_SIZE: 1000,
  // Attempts of the daily check of one organization when the infrastructure fails, and the pause between them
  JOB_ATTEMPTS: 3,
  JOB_BACKOFF_MS: 60_000
} as const

export const FinancePostingLimits = {
  // Attempts of the queue for an error of the INFRASTRUCTURE (the database was down); a failure of the books is never retried by the queue
  MAX_ATTEMPTS: 5,
  // Backoff of the job between attempts, in milliseconds
  BACKOFF_MS: 30_000
} as const

// The memo of an automatic entry: a code the screen translates, never a sentence of one language stored in the books
export const FinanceAutoMemo = {
  PAYMENT: 'auto:payment',
  SENT: 'auto:sent',
  SALE: 'auto:sale',
  CHARGES: 'auto:carrier_charges',
  REMITTANCE_CONFIRM: 'auto:remittance_confirm',
  REMITTANCE_VOID: 'auto:remittance_void',
  COD_WRITE_OFF: 'auto:cod_write_off',
  RETURN_RESTOCK: 'auto:return_restock',
  ORDER_RETURN: 'auto:order_return',
  RETURN_REFUND: 'auto:return_refund',
  ADJUST: 'auto:adjust'
} as const

// How a posting job is asked again when the database was unavailable: a few attempts with a growing pause. A failure of the BOOKS (a
// missing mapping) is not retried by the queue but recorded for a person, so these attempts are for the infrastructure only.
export const financePostingJobOptions = (): {
  attempts: number
  backoff: { type: 'exponential'; delay: number }
  removeOnComplete: true
} => ({
  attempts: FinancePostingLimits.MAX_ATTEMPTS,
  backoff: { type: 'exponential', delay: FinancePostingLimits.BACKOFF_MS },
  removeOnComplete: true
})

// The advisory lock that serializes the events of one source (the decision of E2 against the sale is taken on a settled state)
export const FinanceLockScopes = {
  POSTING: (organizationId: string, sourceType: string, sourceId: string): string =>
    `finance_post:${organizationId}:${sourceType}:${sourceId}`
} as const

// Who is owed what a return gives back (E8): the customer, as an advance the business owes until a person pays it out, or nobody but the
// carrier's receivable, cancelled, when the carrier will never remit the guide
export enum ReturnSettlementKind {
  ADVANCE = 'advance',
  CARRIER = 'carrier'
}

// What the cost of the units put back clears (E8): inventory in transit before the sale, the cost of goods sold after it
export enum ReturnCostAgainst {
  TRANSIT = 'transit',
  COST_OF_GOODS_SOLD = 'cost_of_goods_sold'
}
