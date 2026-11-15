import {
  AccountType,
  CashKind,
  CashKindAccountTypes,
  FinanceLimits,
  NormalSideOfType
} from '@platform/core/domain'
import type { NormalSide } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'

// The rules of the chart of accounts (TDD_18 §2.3): what an account may be, and what may change once it has entries.

export interface AccountDraft {
  code: string
  name: string
  type: AccountType
  isPostable: boolean
  cashKind?: CashKind | null
}

export const normalSideOf = (type: AccountType): NormalSide => NormalSideOfType[type]

// A name has no control character and no stray space, like a warehouse's
const CONTROL = /\p{Cc}/u

export type AccountProblem =
  'code' | 'name' | 'cash_kind_type' | 'cash_kind_postable' | 'unknown_type' | 'unknown_cash_kind'

// What is wrong with an account about to be created or changed; an empty list is a valid account. The database holds the
// same shape in CHECKs, so a write that skips the service cannot put in a code that prints badly.
export function accountProblems(account: AccountDraft): AccountProblem[] {
  const problems: AccountProblem[] = []
  if (!FinanceLimits.ACCOUNT_CODE_PATTERN.test(account.code)) problems.push('code')
  if (
    account.name !== account.name.trim() ||
    account.name.length === 0 ||
    account.name.length > FinanceLimits.ACCOUNT_NAME_MAX_LENGTH ||
    CONTROL.test(account.name)
  ) {
    problems.push('name')
  }
  if (!Object.values(AccountType).includes(account.type)) problems.push('unknown_type')
  const cashKind = account.cashKind ?? null
  if (cashKind !== null) {
    if (!Object.values(CashKind).includes(cashKind)) problems.push('unknown_cash_kind')
    // Cash, a bank account or a wallet is an asset that takes entries: a header only groups
    if (!CashKindAccountTypes.includes(account.type)) problems.push('cash_kind_type')
    if (!account.isPostable) problems.push('cash_kind_postable')
  }
  return problems
}

export interface ChartNode {
  id: string
  parentId: string | null
  type: AccountType
  isPostable: boolean
}

export type ParentProblem =
  typeof ErrorCodes.RESOURCE_NOT_FOUND | 'parent_postable' | 'parent_type' | 'cycle' | 'too_deep'

// Whether `accountId` may sit under `parentId` in the chart `nodes` (the accounts of one organization): the parent exists,
// is a header, has the same type, is not the account itself or one of its descendants, and the chart does not nest deeper
// than the limit. `type` is the type the account has (or will have). Re-parenting is allowed and audited (TDD_18 §2.3).
export function parentProblem(
  nodes: readonly ChartNode[],
  accountId: string | null,
  type: AccountType,
  parentId: string | null
): ParentProblem | null {
  if (parentId === null) return null
  const byId = new Map(nodes.map(node => [node.id, node]))
  const parent = byId.get(parentId)
  if (parent === undefined) return ErrorCodes.RESOURCE_NOT_FOUND
  if (parent.isPostable) return 'parent_postable'
  if (parent.type !== type) return 'parent_type'
  // Walk up from the parent: meeting the account is a cycle, and the walk length is the depth of the new place
  let depth = 1
  let cursor: ChartNode | undefined = parent
  const seen = new Set<string>()
  while (cursor !== undefined) {
    if (cursor.id === accountId) return 'cycle'
    if (seen.has(cursor.id)) return 'cycle'
    seen.add(cursor.id)
    cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId)
    if (cursor !== undefined) depth += 1
  }
  // The deepest branch below the account counts too: moving a group under a deep parent must not push its children past the limit
  const below = accountId === null ? 0 : heightBelow(nodes, accountId)
  return depth + 1 + below > FinanceLimits.MAX_ACCOUNT_DEPTH ? 'too_deep' : null
}

function heightBelow(nodes: readonly ChartNode[], accountId: string): number {
  const children = new Map<string, string[]>()
  for (const node of nodes) {
    if (node.parentId !== null) {
      children.set(node.parentId, [...(children.get(node.parentId) ?? []), node.id])
    }
  }
  const height = (id: string, guard: Set<string>): number => {
    if (guard.has(id)) return 0
    guard.add(id)
    return Math.max(0, ...(children.get(id) ?? []).map(child => 1 + height(child, guard)))
  }
  return height(accountId, new Set())
}

// What an account with entries may no longer change (TDD_18 §2.3): its type, and being a header (the lines it has
// would sit in an account that refuses lines). Renaming and re-parenting stay allowed.
export function lockedChange(
  hasEntries: boolean,
  current: Pick<AccountDraft, 'type' | 'isPostable'>,
  next: Pick<AccountDraft, 'type' | 'isPostable'>
):
  | typeof ErrorCodes.FINANCE_ACCOUNT_TYPE_LOCKED
  | typeof ErrorCodes.FINANCE_ACCOUNT_HAS_ENTRIES
  | null {
  if (!hasEntries) return null
  if (current.type !== next.type) return ErrorCodes.FINANCE_ACCOUNT_TYPE_LOCKED
  if (current.isPostable && !next.isPostable) return ErrorCodes.FINANCE_ACCOUNT_HAS_ENTRIES
  return null
}
