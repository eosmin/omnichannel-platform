'use client'

import { Download, Lock, TriangleAlert } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type ReactElement, useEffect, useState } from 'react'

import { saveCsvFile } from '../../lib/finance/save-file'
import { warningKeyOf } from '../../lib/finance/statement-view'
import { useMoney } from '../../lib/finance/use-money'
import { useSubmitGuard } from '../../lib/submit-guard'
import { useErrorText } from '../../lib/use-error-text'
import { Button } from '../ui/button'

// The parts the statements, the lists with age and the legal books share (Step 4B.9b-3).

// An amount of whole cents, aligned on the digits so a column reads as a column; a negative one keeps its sign
export function Amount({
  cents,
  className
}: {
  cents: string | number
  className?: string
}): ReactElement {
  const money = useMoney()
  return <span className={`tabular-nums ${className ?? ''}`.trim()}>{money(cents)}</span>
}

// What a report could not say whole. A statement that looks complete and is not is the worst one, so the warnings sit above the numbers
// and a code the screen does not know is shown as it came, never dropped
export function ReportWarnings({ warnings }: { warnings: readonly string[] }): ReactElement | null {
  const t = useTranslations('finance.statementsCommon')
  if (warnings.length === 0) return null
  return (
    <div
      role="status"
      data-testid="finance-report-warnings"
      className="border-destructive/40 bg-destructive/5 flex flex-col gap-1 rounded-md border p-3 text-sm"
    >
      <p className="flex items-center gap-2 font-medium">
        <TriangleAlert aria-hidden className="size-4 shrink-0" />
        {t('warningsTitle')}
      </p>
      <ul className="list-disc pl-6">
        {warnings.map(warning => {
          const key = warningKeyOf(warning)
          return (
            <li key={warning} data-warning={warning}>
              {key === null ? warning : t(`warnings.${key}`)}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

// The file of a report, saved as the api wrote it. The name is of the question that was asked, whatever the fields say when it arrives.
// The request is awaited here and not handed callbacks: a callback given to a mutation is dropped when its component goes away, and a
// person who changes the month while a large file is on its way must still get the file they asked for.
export function CsvDownloadButton<Q>({
  label,
  fileName,
  query,
  run,
  isPending
}: {
  label: string
  fileName: string
  query: Q
  run: (query: Q) => Promise<string>
  isPending: boolean
}): ReactElement {
  const errorText = useErrorText()
  const guard = useSubmitGuard()
  const [refusal, setRefusal] = useState<string | null>(null)
  // A refusal belongs to the question that was asked: another one starts clean
  useEffect(() => setRefusal(null), [fileName])
  const start = (): void => {
    if (!guard.enter()) return
    setRefusal(null)
    run(query)
      .then(text => saveCsvFile(fileName, text))
      .catch((error: unknown) => setRefusal(errorText(error)))
      .finally(guard.leave)
  }
  return (
    <div className="flex flex-col gap-1">
      <Button
        type="button"
        size="sm"
        variant="outline"
        data-testid="finance-report-csv"
        disabled={isPending}
        busy={isPending}
        onClick={start}
      >
        <Download aria-hidden />
        {label}
      </Button>
      {refusal === null ? null : (
        <p role="alert" className="text-destructive text-sm">
          {refusal}
        </p>
      )}
    </div>
  )
}

// Whether what a report reads can still move. A month that is closed does not change unless it is reopened (with a reason, and the api
// writes it down), so a report whose last day is in closed months is a settled one; the page says so, and says how far the books are
// closed when only part of the range is.
export function ClosedThroughNote({
  lockedThrough,
  lastDay
}: {
  lockedThrough: string | null
  lastDay: string
}): ReactElement | null {
  const t = useTranslations('finance.statementsCommon.closed')
  if (lockedThrough === null) return null
  const settled = lastDay <= lockedThrough
  return (
    <p
      data-testid="finance-report-closed-note"
      data-settled={String(settled)}
      className="bg-muted/50 flex items-start gap-2 rounded-md p-3 text-sm"
    >
      <Lock aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span>{settled ? t('settled') : t('partly', { date: lockedThrough })}</span>
    </p>
  )
}
