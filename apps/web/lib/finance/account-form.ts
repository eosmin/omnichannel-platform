import type {
  CreateFinanceAccountInput,
  FinanceAccountView,
  UpdateFinanceAccountInput
} from '@platform/api-client'
import { AccountType, CashKindAccountTypes, FinanceLimits } from '@platform/core/domain'

// The form of an account of the chart (TDD_18 §3). The rules that need the books (an account with entries cannot change type,
// a header cannot post) are the api's: it answers with a code the screen has a text for.
export interface AccountDraft {
  code: string
  name: string
  type: string
  // '' is no parent
  parentId: string
  isPostable: boolean
  // '' is not cash
  cashKind: string
}

export const AccountFields = { CODE: 'code', NAME: 'name', CASH_KIND: 'cashKind' } as const
export type AccountField = (typeof AccountFields)[keyof typeof AccountFields]

export const emptyAccountDraft = (): AccountDraft => ({
  code: '',
  name: '',
  type: AccountType.ASSET,
  parentId: '',
  isPostable: true,
  cashKind: ''
})

export const accountDraftOf = (account: FinanceAccountView): AccountDraft => ({
  code: account.code,
  name: account.name,
  type: account.type,
  parentId: account.parentId ?? '',
  isPostable: account.isPostable,
  cashKind: account.cashKind ?? ''
})

export const canBeCash = (type: string): boolean =>
  CashKindAccountTypes.some(allowed => String(allowed) === type)

// The first field that is wrong, or null
export function accountProblem(draft: AccountDraft): AccountField | null {
  if (!FinanceLimits.ACCOUNT_CODE_PATTERN.test(draft.code.trim())) return AccountFields.CODE
  const name = draft.name.trim()
  if (name === '' || name.length > FinanceLimits.ACCOUNT_NAME_MAX_LENGTH) return AccountFields.NAME
  // Only an asset can be cash, a bank account or a wallet
  if (draft.cashKind !== '' && !canBeCash(draft.type)) return AccountFields.CASH_KIND
  return null
}

export function createAccountInputOf(draft: AccountDraft): CreateFinanceAccountInput {
  return {
    code: draft.code.trim(),
    name: draft.name.trim(),
    type: draft.type,
    parentId: draft.parentId === '' ? null : draft.parentId,
    isPostable: draft.isPostable,
    cashKind: draft.cashKind === '' ? null : draft.cashKind
  }
}

// Only the keys that differ from the account, so an edit of the name never sends the type
export function updateAccountInputOf(
  account: FinanceAccountView,
  draft: AccountDraft
): UpdateFinanceAccountInput {
  const next = createAccountInputOf(draft)
  const changes: UpdateFinanceAccountInput = {}
  if (next.code !== account.code) changes.code = next.code
  if (next.name !== account.name) changes.name = next.name
  if (next.type !== account.type) changes.type = next.type
  if (next.parentId !== account.parentId) changes.parentId = next.parentId
  if (next.isPostable !== account.isPostable) changes.isPostable = next.isPostable
  if (next.cashKind !== account.cashKind) changes.cashKind = next.cashKind
  return changes
}

export interface AccountRow {
  account: FinanceAccountView
  // How deep it sits under its headers, for the indent; 0 at the top
  depth: number
}

// The chart in the order of its codes, each account under its parent. An account whose parent is not in the list (a page that
// failed to load, a parent that is gone) is drawn at the top, so none is ever lost from the screen.
const byCode = (a: FinanceAccountView, b: FinanceAccountView): number =>
  a.code.localeCompare(b.code, 'en', { numeric: true })

export function accountRowsOf(accounts: readonly FinanceAccountView[]): AccountRow[] {
  const sorted = [...accounts].sort(byCode)
  const ids = new Set(sorted.map(account => account.id))
  const children = new Map<string | null, FinanceAccountView[]>()
  for (const account of sorted) {
    const parent = account.parentId !== null && ids.has(account.parentId) ? account.parentId : null
    const siblings = children.get(parent)
    if (siblings === undefined) children.set(parent, [account])
    else siblings.push(account)
  }
  const rows: AccountRow[] = []
  const seen = new Set<string>()
  const walk = (parent: string | null, depth: number): void => {
    for (const account of children.get(parent) ?? []) {
      // A loop in the parents (the api refuses it) cannot make the walk run for ever
      if (seen.has(account.id)) continue
      seen.add(account.id)
      rows.push({ account, depth })
      walk(account.id, depth + 1)
    }
  }
  walk(null, 0)
  // What the walk from the top never reached (a loop of parents, which the api refuses) is drawn at the top, so none is lost
  for (const account of sorted) {
    if (!seen.has(account.id)) {
      seen.add(account.id)
      rows.push({ account, depth: 0 })
      walk(account.id, 1)
    }
  }
  return rows
}

// The accounts that may be the parent of another: the ones that only group (not postable), never the account itself
export function parentOptionsOf(
  accounts: readonly FinanceAccountView[],
  selfId: string | null
): FinanceAccountView[] {
  // Not the account under itself either: a header cannot be placed inside one of its own children (a loop of parents)
  const below = new Set<string>(selfId === null ? [] : [selfId])
  let grew = selfId !== null
  while (grew) {
    grew = false
    for (const account of accounts) {
      if (account.parentId !== null && below.has(account.parentId) && !below.has(account.id)) {
        below.add(account.id)
        grew = true
      }
    }
  }
  return accounts.filter(account => !account.isPostable && !below.has(account.id)).sort(byCode)
}

// The accounts a rate or a role can point at: the ones that post and are on, plus the ones already chosen (an account turned off
// since stays in the list, or the select would show an empty choice for a value it holds)
export function postableAccountsOf(
  accounts: readonly FinanceAccountView[],
  keep: readonly string[]
): FinanceAccountView[] {
  return accounts
    .filter(account => (account.isPostable && account.active) || keep.includes(account.id))
    .sort(byCode)
}

// The accounts money can sit in: cash, a bank or a wallet (TDD_18 §3), of the kinds given or of any when none is. The one already
// chosen stays in the list, as in `postableAccountsOf`.
export function cashAccountsOf(
  accounts: readonly FinanceAccountView[],
  keep: readonly string[],
  kinds?: readonly string[]
): FinanceAccountView[] {
  return postableAccountsOf(accounts, keep).filter(
    account =>
      keep.includes(account.id) ||
      (account.cashKind !== null && (kinds === undefined || kinds.includes(account.cashKind)))
  )
}

// "1101 · Cash": how an account is named wherever a list or a line shows it; an id that is not in the chart (never expected) shows as itself
export function accountLabelsOf(
  accounts: readonly FinanceAccountView[]
): (accountId: string | null) => string {
  const byId = new Map(accounts.map(account => [account.id, account]))
  return accountId => {
    if (accountId === null) return ''
    const account = byId.get(accountId)
    return account === undefined ? accountId : `${account.code} · ${account.name}`
  }
}
