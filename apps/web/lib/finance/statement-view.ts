import type {
  FinanceAgingView,
  FinanceStatementRowView,
  FinanceStatementSectionView
} from '@platform/api-client'
import {
  AccountRole,
  AgingBucketDays,
  FinanceSourceType,
  PartyType,
  StatementWarning
} from '@platform/core/domain'


// What the pages of the statements read from an answer. Nothing here knows a country or a chart: the rows come grouped by the chart of the
// accountant (type and parent), and a total is the one the api computed, never one added again on the screen.

// The message of each warning a statement can carry (`finance.statements.warnings.<key>`); one the screen does not know is shown by its
// code, so a new warning of the api is never hidden
export type StatementWarningKey =
  | 'noIncome'
  | 'noCostOfSales'
  | 'noCashAccounts'
  | 'roleNotMapped'
  | 'linesWithoutParty'
  | 'notBalanced'
  | 'cashFlowDoesNotClose'

const WARNING_KEYS: ReadonlyMap<string, StatementWarningKey> = new Map<string, StatementWarningKey>(
  [
    [StatementWarning.NO_INCOME, 'noIncome'],
    [StatementWarning.NO_COST_OF_SALES, 'noCostOfSales'],
    [StatementWarning.NO_CASH_ACCOUNTS, 'noCashAccounts'],
    [StatementWarning.ROLE_NOT_MAPPED, 'roleNotMapped'],
    [StatementWarning.LINES_WITHOUT_PARTY, 'linesWithoutParty'],
    [StatementWarning.NOT_BALANCED, 'notBalanced'],
    [StatementWarning.CASH_FLOW_DOES_NOT_CLOSE, 'cashFlowDoesNotClose']
  ]
)

export const warningKeyOf = (warning: string): StatementWarningKey | null =>
  WARNING_KEYS.get(warning) ?? null

// A source of the cash flow is the kind of record that moved the money
// A closed list as a lookup that no member of Object.prototype can answer, and that hands back the typed value (a message key)
const lookup = <E extends string>(values: Record<string, E>): ReadonlyMap<string, E> =>
  new Map(Object.values(values).map(value => [value as string, value]))

const SOURCE_KEYS = lookup<FinanceSourceType>(FinanceSourceType)
export const sourceKeyOf = (source: string): FinanceSourceType | null =>
  SOURCE_KEYS.get(source) ?? null

const ROLE_KEYS = lookup<AccountRole>(AccountRole)
export const accountRoleOf = (role: string): AccountRole | null => ROLE_KEYS.get(role) ?? null

const PARTY_KEYS = lookup<PartyType>(PartyType)
export const partyKeyOf = (type: string | null): PartyType | null =>
  type === null ? null : (PARTY_KEYS.get(type) ?? null)

export interface IndentedRow {
  row: FinanceStatementRowView
  depth: number
}

// The rows of a section as the chart nests them: a row sits under its parent when the parent is in the section, and what has no parent
// in the section is a root. The order of the api (by code) is kept inside each level. A cycle cannot loop: a row is placed once.
export function indentedRows(section: FinanceStatementSectionView): IndentedRow[] {
  const ids = new Set(section.rows.map(row => row.accountId))
  const children = new Map<string | null, FinanceStatementRowView[]>()
  for (const row of section.rows) {
    const parent = row.parentId !== null && ids.has(row.parentId) ? row.parentId : null
    const list = children.get(parent) ?? []
    list.push(row)
    children.set(parent, list)
  }
  const placed = new Set<string>()
  const result: IndentedRow[] = []
  const visit = (parent: string | null, depth: number): void => {
    for (const row of children.get(parent) ?? []) {
      if (placed.has(row.accountId)) continue
      placed.add(row.accountId)
      result.push({ row, depth })
      visit(row.accountId, depth + 1)
    }
  }
  visit(null, 0)
  // What a cycle of parents left out is still listed, at the root: a statement never drops an account
  for (const row of section.rows) {
    if (!placed.has(row.accountId)) {
      placed.add(row.accountId)
      result.push({ row, depth: 0 })
    }
  }
  return result
}

// The age of a bucket as a label: the upper bounds [30, 60, 90] are the buckets 0-30, 31-60, 61-90 and more than 90
export interface BucketLabel {
  kind: 'range' | 'over'
  from: number
  to: number
}

export function bucketLabels(bucketDays: readonly number[]): BucketLabel[] {
  const bounds = bucketDays.length === 0 ? [...AgingBucketDays] : [...bucketDays]
  const labels: BucketLabel[] = []
  let from = 0
  for (const to of bounds) {
    labels.push({ kind: 'range', from, to })
    from = to + 1
  }
  labels.push({ kind: 'over', from: from - 1, to: from - 1 })
  return labels
}

// A row of the list with age that no party owns: the lines that carry no party, in the total and in no row
export const isUnassignedRow = (row: FinanceAgingView['rows'][number]): boolean =>
  row.partyId === null

// A statement that has nothing to say: no row in any section
export const sectionsAreEmpty = (...sections: FinanceStatementSectionView[]): boolean =>
  sections.every(section => section.rows.length === 0)
