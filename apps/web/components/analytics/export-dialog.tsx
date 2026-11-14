'use client'

import { useIsMutating } from '@tanstack/react-query'
import { Download } from 'lucide-react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useId, useState } from 'react'

import { AppPaths, type ExportView } from '@platform/api-client'
import {
  AnalyticsFileFormats,
  type AnalyticsFileFormat,
  ReportFormats,
  ReportMetrics
} from '@platform/core/analytics'

import { useExportAnalytics } from '../../lib/analytics/use-reports'
import { useSubmitGuard } from '../../lib/submit-guard'
import { useErrorText } from '../../lib/use-error-text'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import { SELECT_CLASS } from '../ui/field-classes'
import { Label } from '../ui/label'

import { MetricPicker } from './metric-picker'

// "Export" of the dashboard (TDD_11 §7.3): the figures of the period on the screen, as a CSV, Excel or PDF file made in the
// background. The answer is the row to follow in the exports center, so the dialog ends by pointing there.
// `from` and `to` are calendar days (UTC), the last one out, the same days the dashboard draws.
export function ExportDialog({
  open,
  onOpenChange,
  from,
  to
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  from: string
  to: string
}): ReactElement {
  const t = useTranslations('analytics.export')
  // A request on its way keeps the dialog open: its answer (the link to the exports center, a refusal) is shown by the form
  const sending = useIsMutating() > 0
  return (
    <Dialog open={open} onOpenChange={next => (next || !sending ? onOpenChange(next) : undefined)}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description', { from, to })}</DialogDescription>
        </DialogHeader>
        {/* Mounted only while open: every opening starts from the whole list and the CSV */}
        {open ? <ExportForm from={from} to={to} onClose={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  )
}

function ExportForm({
  from,
  to,
  onClose
}: {
  from: string
  to: string
  onClose: () => void
}): ReactElement {
  const t = useTranslations('analytics.export')
  const errorText = useErrorText()
  const { storeId } = useStore()
  const guard = useSubmitGuard()
  const exportFile = useExportAnalytics(storeId)
  const idPrefix = useId()
  const [metrics, setMetrics] = useState<string[]>([...ReportMetrics])
  const [format, setFormat] = useState<AnalyticsFileFormat>(ReportFormats.CSV)
  const [queued, setQueued] = useState<ExportView | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [empty, setEmpty] = useState(false)

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (metrics.length === 0) {
      setEmpty(true)
      return
    }
    if (!guard.enter()) return
    setRefusal(null)
    exportFile.mutate(
      // In the order of the catalog, whatever order they were ticked in
      { metrics: ReportMetrics.filter(metric => metrics.includes(metric)), from, to, format },
      {
        onSuccess: setQueued,
        onError: error => setRefusal(errorText(error)),
        onSettled: guard.leave
      }
    )
  }

  if (queued !== null) {
    return (
      <div className="flex flex-col gap-3">
        <p role="status" className="text-sm">
          {t('queued')}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button asChild>
            <Link href={AppPaths.store.exports(storeId)}>{t('goToExports')}</Link>
          </Button>
          <Button variant="outline" onClick={onClose}>
            {t('close')}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3" aria-label={t('formLabel')}>
      <MetricPicker
        value={metrics}
        onChange={next => {
          setMetrics(next)
          setEmpty(false)
        }}
        disabled={exportFile.isPending}
        invalid={empty}
        errorId={`${idPrefix}-metrics-error`}
      />
      {empty ? (
        <p id={`${idPrefix}-metrics-error`} role="alert" className="text-destructive text-sm">
          {t('noMetrics')}
        </p>
      ) : null}
      <div className="grid gap-1.5">
        <Label htmlFor={`${idPrefix}-format`}>{t('format')}</Label>
        <select
          id={`${idPrefix}-format`}
          className={`${SELECT_CLASS} sm:w-48`}
          value={format}
          disabled={exportFile.isPending}
          onChange={event => {
            const next = AnalyticsFileFormats.find(item => item === event.target.value)
            if (next !== undefined) setFormat(next)
          }}
        >
          {AnalyticsFileFormats.map(item => (
            <option key={item} value={item}>
              {t(`formats.${item}`)}
            </option>
          ))}
        </select>
      </div>
      {refusal === null ? null : (
        <p role="alert" className="text-destructive text-sm">
          {refusal}
        </p>
      )}
      <div>
        <Button type="submit" busy={exportFile.isPending}>
          <Download aria-hidden />
          {t('submit')}
        </Button>
      </div>
    </form>
  )
}
