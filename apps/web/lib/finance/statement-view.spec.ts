import type { FinanceStatementRowView } from '@platform/api-client'
import { FinanceSourceType, PartyType, StatementWarning } from '@platform/core/domain'

import {
  bucketLabels,
  indentedRows,
  partyKeyOf,
  sectionsAreEmpty,
  sourceKeyOf,
  warningKeyOf
} from './statement-view'

const row = (
  id: string,
  parentId: string | null,
  overrides: Partial<FinanceStatementRowView> = {}
): FinanceStatementRowView => ({
  accountId: id,
  code: id,
  name: `Account ${id}`,
  parentId,
  isPostable: true,
  balanceCents: '100',
  rollupCents: '100',
  ...overrides
})

describe('the warnings of a statement', () => {
  it('has a message for every warning the api can send', () => {
    for (const warning of Object.values(StatementWarning)) {
      expect(warningKeyOf(warning)).not.toBeNull()
    }
  })

  it('leaves a warning it does not know to be shown as it came', () => {
    expect(warningKeyOf('something_new')).toBeNull()
    // Not a member of Object.prototype either
    expect(warningKeyOf('constructor')).toBeNull()
    expect(sourceKeyOf('toString')).toBeNull()
    expect(partyKeyOf('__proto__')).toBeNull()
  })
})

describe('the sources of the cash flow and the parties of a list', () => {
  it('has a label for every kind of record and every kind of party', () => {
    for (const source of Object.values(FinanceSourceType)) expect(sourceKeyOf(source)).toBe(source)
    for (const type of Object.values(PartyType)) expect(partyKeyOf(type)).toBe(type)
    expect(sourceKeyOf('other')).toBeNull()
    expect(partyKeyOf(null)).toBeNull()
  })
})

describe('the rows of a section as the chart nests them', () => {
  it('puts a row under its parent, in the order of the api', () => {
    const rows = indentedRows({
      totalCents: '300',
      rows: [row('1', null), row('11', '1'), row('12', '1'), row('2', null), row('21', '2')]
    })
    expect(rows.map(item => [item.row.accountId, item.depth])).toEqual([
      ['1', 0],
      ['11', 1],
      ['12', 1],
      ['2', 0],
      ['21', 1]
    ])
  })

  it('treats a row whose parent is not in the section as a root', () => {
    const rows = indentedRows({ totalCents: '100', rows: [row('11', '1')] })
    expect(rows).toEqual([{ row: row('11', '1'), depth: 0 }])
  })

  it('never drops an account, not even when the parents make a cycle', () => {
    const rows = indentedRows({ totalCents: '200', rows: [row('a', 'b'), row('b', 'a')] })
    expect(rows.map(item => item.row.accountId).sort()).toEqual(['a', 'b'])
  })
})

describe('the buckets of the list with age', () => {
  it('are the upper bounds of the api and one more, open at the end', () => {
    expect(bucketLabels([30, 60, 90])).toEqual([
      { kind: 'range', from: 0, to: 30 },
      { kind: 'range', from: 31, to: 60 },
      { kind: 'range', from: 61, to: 90 },
      { kind: 'over', from: 90, to: 90 }
    ])
  })

  it('falls back to the constant of the books when the api sends none', () => {
    expect(bucketLabels([])).toHaveLength(4)
  })
})

describe('an empty statement', () => {
  it('has no row in any section', () => {
    expect(sectionsAreEmpty({ rows: [], totalCents: '0' }, { rows: [], totalCents: '0' })).toBe(
      true
    )
    expect(
      sectionsAreEmpty({ rows: [row('1', null)], totalCents: '100' }, { rows: [], totalCents: '0' })
    ).toBe(false)
  })
})
