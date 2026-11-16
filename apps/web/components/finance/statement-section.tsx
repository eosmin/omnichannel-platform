'use client'

import type { ReactElement, ReactNode } from 'react'

import type { FinanceStatementSectionView } from '@platform/api-client'

import { indentedRows } from '../../lib/finance/statement-view'

import { Amount } from './report-parts'

// One section of a statement: its accounts as the chart nests them and the total the api computed for it. A parent shows what it rolls
// up; the screen never adds a column again, so what is drawn is what the api said.
export function StatementSection({
  title,
  totalLabel,
  section,
  emptyText,
  testId
}: {
  title: string
  totalLabel: string
  section: FinanceStatementSectionView
  emptyText: string
  testId: string
}): ReactElement {
  const rows = indentedRows(section)
  return (
    <section className="flex flex-col gap-2" data-testid={testId} aria-label={title}>
      <h3 className="text-base font-semibold">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">{emptyText}</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {rows.map(({ row, depth }) => (
            <li
              key={row.accountId}
              data-account={row.code}
              className="flex items-baseline justify-between gap-3 px-3 py-2 text-sm"
              style={{ paddingInlineStart: `${String(0.75 + depth * 1.25)}rem` }}
            >
              <span className={row.isPostable ? '' : 'font-medium'}>
                <span className="text-muted-foreground me-2 text-xs">{row.code}</span>
                {row.name}
              </span>
              <Amount cents={row.rollupCents} className={row.isPostable ? '' : 'font-medium'} />
            </li>
          ))}
        </ul>
      )}
      <TotalLine label={totalLabel} cents={section.totalCents} testId={`${testId}-total`} />
    </section>
  )
}

// A line that says a total: the sum of a section, the margin, the result
export function TotalLine({
  label,
  cents,
  testId,
  note
}: {
  label: ReactNode
  cents: string
  testId: string
  note?: ReactNode
}): ReactElement {
  return (
    <div
      data-testid={testId}
      className="bg-muted/50 flex flex-col gap-0.5 rounded-md px-3 py-2 text-sm font-semibold"
    >
      <div className="flex items-baseline justify-between gap-3">
        <span>{label}</span>
        <Amount cents={cents} />
      </div>
      {note === undefined ? null : (
        <span className="text-muted-foreground text-xs font-normal">{note}</span>
      )}
    </div>
  )
}
