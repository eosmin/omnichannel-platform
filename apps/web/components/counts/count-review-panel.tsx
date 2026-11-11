'use client'

import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import type { CountLineView } from '@platform/api-client'

import type { ApplyRefusal } from '../../lib/counts/count-conflict'
import { linesWithVariance, varianceSummary } from '../../lib/counts/count-sheet'
import { cn } from '../../lib/utils'

// The review of a count in `review` (and what an applied one did): per line, what the shelf held when the count began
// (the snapshot), what was counted and the difference. Only the difference is ever written; sales and transfers that
// happened while counting are not touched, and the screen says so.
export function CountReviewPanel({
  lines,
  applied,
  refusal
}: {
  lines: readonly CountLineView[]
  applied: boolean
  refusal: ApplyRefusal | null
}): ReactElement {
  const t = useTranslations('counts.review')
  const summary = varianceSummary(lines)
  const differing = linesWithVariance(lines)
  const flagged = new Set(refusal?.lines.map(item => item.lineId))

  return (
    <section aria-label={t('label')} className="flex flex-col gap-3">
      <p className="text-muted-foreground text-sm">
        {applied ? t('appliedNote') : t('snapshotNote')}
      </p>
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Figure label={t('withVariance')} value={summary.withVariance} />
        <Figure label={t('unitsIn')} value={`+${summary.unitsIn}`} />
        <Figure label={t('unitsOut')} value={`-${summary.unitsOut}`} />
        <Figure label={t('uncounted')} value={summary.uncounted} />
      </dl>
      {summary.uncounted > 0 ? (
        <p className="text-sm">{t('uncountedNote', { count: summary.uncounted })}</p>
      ) : null}
      {differing.length === 0 ? (
        <p role="status" className="text-muted-foreground py-4 text-center text-sm">
          {t('noVariance')}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {differing.map(line => (
            <li
              key={line.id}
              className={cn(
                'flex items-center justify-between gap-3 rounded-lg border p-3',
                flagged.has(line.id) && 'border-destructive'
              )}
            >
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="font-medium break-words">{line.productName}</span>
                {line.variantName !== null ? (
                  <span className="text-muted-foreground text-sm break-words">
                    {line.variantName}
                  </span>
                ) : null}
                {line.sku !== null ? (
                  <span className="text-muted-foreground font-mono text-xs break-all">
                    {line.sku}
                  </span>
                ) : null}
              </div>
              <dl className="flex shrink-0 items-center gap-4 text-sm tabular-nums">
                <Quantity label={t('expected')} value={line.expectedQuantity} />
                <Quantity label={t('counted')} value={line.countedQuantity ?? 0} />
                <Quantity
                  label={t('variance')}
                  value={signed(line.variance ?? 0)}
                  strong
                  tone={(line.variance ?? 0) > 0 ? 'in' : 'out'}
                />
              </dl>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

const signed = (value: number): string => (value > 0 ? `+${value}` : String(value))

function Figure({ label, value }: { label: string; value: number | string }): ReactElement {
  return (
    <div className="rounded-lg border p-3">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-xl font-semibold tabular-nums">{value}</dd>
    </div>
  )
}

function Quantity({
  label,
  value,
  strong = false,
  tone
}: {
  label: string
  value: number | string
  strong?: boolean
  tone?: 'in' | 'out'
}): ReactElement {
  return (
    <div className="flex flex-col items-end">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd
        className={cn(
          strong && 'text-base font-semibold',
          tone === 'in' && 'text-green-700 dark:text-green-400',
          tone === 'out' && 'text-destructive'
        )}
      >
        {value}
      </dd>
    </div>
  )
}
