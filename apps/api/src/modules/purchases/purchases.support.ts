import type { PrismaTransaction } from '@platform/core/database'
import { type AccountRole, type PurchaseConflicts, PurchaseLimits } from '@platform/core/domain'
import {
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  resourceNotFound
} from '@platform/core/errors'
import { dateToDay, dayToDate } from '@platform/core/finance'

export { lockScope } from '../finance/finance.support'

const MS_PER_DAY = 86_400_000

// The account an automatic entry posts to for a role. A role without a mapping makes the posting FAIL VISIBLY, never fall into a default
// (TDD_18 §3): the answer names the role, and the interface says which one to map.
export async function roleAccount(
  tx: PrismaTransaction,
  organizationId: string,
  role: AccountRole
): Promise<string> {
  const mapping = await tx.accountRoleMapping.findUnique({
    where: { organizationId_role: { organizationId, role } },
    select: { accountId: true }
  })
  if (mapping === null) {
    throw new PlatformException(
      ErrorCodes.FINANCE_ROLE_NOT_MAPPED,
      'the role has no account mapped',
      HttpStatusCodes.CONFLICT,
      { role }
    )
  }
  return mapping.accountId
}

// The latest accounting day a receipt or a payment may have: today (UTC) and the day of slack the person's clock may have over it
export function latestDay(): string {
  return dateToDay(new Date(Date.now() + PurchaseLimits.FUTURE_DAYS * MS_PER_DAY))
}

export function today(): string {
  return dateToDay(new Date())
}

// The days a bill is past due: a count between two accounting days, by the calendar and not by 24-hour blocks
export function daysPastDue(dueOn: string, day: string): number {
  return Math.max(
    0,
    Math.round((dayToDate(day).getTime() - dayToDate(dueOn).getTime()) / MS_PER_DAY)
  )
}

// The answer for a request that a rule of purchases refuses: the first problem decides, the list is for the log
export const invalidPurchase = (problems: readonly string[]): PlatformException =>
  new PlatformException(
    ErrorCodes.VALIDATION_INVALID_INPUT,
    'the request breaks a rule of purchases',
    HttpStatusCodes.BAD_REQUEST,
    { problems }
  )

export const invalidTransition = (
  from: string,
  to: string,
  conflict?: (typeof PurchaseConflicts)[keyof typeof PurchaseConflicts]
): PlatformException =>
  new PlatformException(
    ErrorCodes.PURCHASE_ORDER_INVALID_STATUS_TRANSITION,
    'a purchase order does not move that way',
    HttpStatusCodes.CONFLICT,
    conflict === undefined ? { from, to } : { from, to, conflict }
  )

// A row of the organization, or the answer that it does not exist (an id of another organization is an id that does not exist)
export function found<T>(row: T | null, what: string): T {
  if (row === null) throw resourceNotFound(what)
  return row
}
