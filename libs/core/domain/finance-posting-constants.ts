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
  // E8: a return was received
  RETURN_RESTOCK = 'return_restock',
  // E9: a stock adjustment, a count variance or a transfer write-off
  ADJUST = 'adjust'
}

// The kind of source each event reads: a job that pairs another kind with an event has nothing to post (the job's schema is not
// enough, it only checks that both exist)
export const FinanceEventSource: Readonly<Record<FinanceEventKind, FinanceSourceType>> = {
  [FinanceEventKind.PAYMENT]: FinanceSourceType.ORDER,
  [FinanceEventKind.SENT]: FinanceSourceType.ORDER,
  [FinanceEventKind.SALE]: FinanceSourceType.ORDER,
  [FinanceEventKind.RETURN_RESTOCK]: FinanceSourceType.RETURN,
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
  FAILED = 'failed'
}

// The idempotency key of the entry each event posts (TDD_18 §4.1)
export const FinancePostingKey = {
  ORDER_PAYMENT: (orderId: string): string => `order:${orderId}:payment`,
  ORDER_SENT: (orderId: string): string => `order:${orderId}:sent`,
  ORDER_SALE: (orderId: string): string => `order:${orderId}:sale`,
  RETURN_RESTOCK: (returnId: string): string => `return:${returnId}:restock`,
  MOVEMENT_ADJUST: (movementId: string): string => `movement:${movementId}:adjust`
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
  RETURN_RESTOCK: 'auto:return_restock',
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
