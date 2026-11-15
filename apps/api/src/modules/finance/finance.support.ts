import { type Permission, Permissions } from '@platform/core/auth'
import { type PrismaTransaction, isUniqueViolation } from '@platform/core/database'
import { FinanceConflicts, FinanceTransactionKind } from '@platform/core/domain'
import {
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  resourceConflict,
  resourceNotFound
} from '@platform/core/errors'
import { dayToDate } from '@platform/core/finance'
import { financeRefusal } from '@platform/core/finance-ledger'

// The accounting date of a 'YYYY-MM-DD' string, as the DATE columns take it
export const dayDate = dayToDate

export const codeInUse = (): PlatformException =>
  resourceConflict('an account of the organization already has that code', {
    conflict: FinanceConflicts.ACCOUNT_CODE_IN_USE
  })

// The answer for a request that a rule of the chart refuses: the first problem decides, the list is for the log
export const invalidChart = (problems: readonly string[]): PlatformException =>
  new PlatformException(
    ErrorCodes.VALIDATION_INVALID_INPUT,
    'the account breaks a rule of the chart',
    HttpStatusCodes.BAD_REQUEST,
    { problems }
  )

// A rule of the chart that the state of the books refuses (a type that entries locked, a header that has entries)
export const lockedAccount = (
  code:
    typeof ErrorCodes.FINANCE_ACCOUNT_TYPE_LOCKED | typeof ErrorCodes.FINANCE_ACCOUNT_HAS_ENTRIES
): PlatformException =>
  new PlatformException(
    code,
    'the account has entries, so that cannot change',
    HttpStatusCodes.CONFLICT
  )

// The chart, the maps and the payment accounts of an organization change one request at a time: a count that holds a limit,
// a cycle that two moves could make together and the code that two accounts could both take are decided under this lock
export async function lockChart(tx: PrismaTransaction, organizationId: string): Promise<void> {
  await lockScope(tx, `${organizationId}:finance_chart`)
}

// A named lock until the transaction ends: the requests that name the same scope take turns (the key of a request, the chart of an
// organization), the others do not wait
export async function lockScope(tx: PrismaTransaction, scope: string): Promise<void> {
  await tx.$queryRaw`
    SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended(${scope}, 0))) AS lock`
}

// The unique index of the code is what holds when two requests ask for the same code at the same moment
export async function codeTransaction<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (isUniqueViolation(error)) throw codeInUse()
    throw error
  }
}

// An account a setting or a role is about to point at must take entries and be on
export async function usableAccount(
  tx: PrismaTransaction,
  organizationId: string,
  accountId: string
): Promise<{ id: string }> {
  const account = await tx.ledgerAccount.findFirst({
    where: { id: accountId, organizationId },
    select: { id: true, active: true, isPostable: true }
  })
  if (account === null) throw resourceNotFound('ledger account')
  if (!account.isPostable) {
    throw financeRefusal(ErrorCodes.FINANCE_ACCOUNT_NOT_POSTABLE, { accountId })
  }
  if (!account.active) throw financeRefusal(ErrorCodes.FINANCE_ACCOUNT_INACTIVE, { accountId })
  return account
}

// The finance settings of the organization, or the answer that says it has none yet
export async function requireSettings(
  tx: PrismaTransaction,
  organizationId: string
): Promise<void> {
  const found = await tx.financeSettings.findUnique({
    where: { organizationId },
    select: { organizationId: true }
  })
  if (found === null) throw financeRefusal(ErrorCodes.FINANCE_SETUP_REQUIRED)
}

// A transaction registered by hand needs the permission of its kind (TDD_18 §9.1): an expense or an income is
// `finance:manage_transactions`, any movement of cash between accounts is `finance:move_money`. The routes accept either (a
// bookkeeper may hold one and not the other), so the kind is narrowed here, before anything is read or written.
export const PermissionOfTransactionKind: Readonly<Record<FinanceTransactionKind, Permission>> = {
  [FinanceTransactionKind.EXPENSE]: Permissions.FINANCE_MANAGE_TRANSACTIONS,
  [FinanceTransactionKind.INCOME]: Permissions.FINANCE_MANAGE_TRANSACTIONS,
  [FinanceTransactionKind.TRANSFER]: Permissions.FINANCE_MOVE_MONEY
}

export function requireTransactionPermission(
  kind: FinanceTransactionKind,
  granted: readonly Permission[]
): void {
  const required = PermissionOfTransactionKind[kind]
  if (!granted.includes(required)) {
    throw new PlatformException(
      ErrorCodes.PERMISSION_DENIED,
      'Missing permission',
      HttpStatusCodes.FORBIDDEN,
      { required: [required] }
    )
  }
}
