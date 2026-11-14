'use client'

import { useIsMutating } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useId, useState } from 'react'

import type { ReportView } from '@platform/api-client'
import { AnalyticsFileFormats, ReportFrequency, ReportLimits } from '@platform/core/analytics'

import {
  browserTimeZone,
  createInputOf,
  emptyReportDraft,
  hourLabel,
  type ReportDraft,
  type ReportField,
  ReportFields,
  reportDraftOf,
  reportProblem,
  updateInputOf
} from '../../lib/analytics/report-form'
import { useCreateReport, useUpdateReport } from '../../lib/analytics/use-reports'
import { useSubmitGuard } from '../../lib/submit-guard'
import { toast } from '../../lib/toast'
import { useErrorText } from '../../lib/use-error-text'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import { SELECT_CLASS } from '../ui/field-classes'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Textarea } from '../ui/textarea'

import { MetricPicker } from './metric-picker'

const HOURS = Array.from({ length: 24 }, (_, hour) => hour)

// Every time zone this browser knows, with the one the form starts from among them (`supportedValuesOf` is missing in an old
// browser: then the one zone is all there is to choose from)
function timeZonesWith(current: string): string[] {
  const zones = knownTimeZones()
  return zones.includes(current) ? zones : [current, ...zones]
}

function knownTimeZones(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone')
  } catch {
    return []
  }
}

// Making and editing a scheduled report (TDD_11 §7.4). `report` is null to make one. The api needs analytics:export as well as
// analytics:manage_reports to save one (a report sends the figures out by email); the page opens the dialog only to whoever has both.
export function ReportDialog({
  report,
  open,
  onOpenChange
}: {
  report: ReportView | null
  open: boolean
  onOpenChange: (open: boolean) => void
}): ReactElement {
  const t = useTranslations('analytics.reports.form')
  // A save on its way keeps the dialog open: its answer (a toast, a refusal) is shown by the form that sent it
  const saving = useIsMutating() > 0
  return (
    <Dialog open={open} onOpenChange={next => (next || !saving ? onOpenChange(next) : undefined)}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{report === null ? t('createTitle') : t('editTitle')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        {/* Mounted only while open: every opening starts from what the list holds now */}
        {open ? (
          <ReportForm
            key={report?.id ?? 'new'}
            report={report}
            onSaved={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function ReportForm({
  report,
  onSaved
}: {
  report: ReportView | null
  onSaved: () => void
}): ReactElement {
  const t = useTranslations('analytics.reports.form')
  const tFrequency = useTranslations('analytics.reports.frequency')
  const tFormat = useTranslations('analytics.export.formats')
  const errorText = useErrorText()
  const { storeId } = useStore()
  const guard = useSubmitGuard()
  const create = useCreateReport(storeId)
  const update = useUpdateReport(storeId)
  const idPrefix = useId()
  const [draft, setDraft] = useState<ReportDraft>(() =>
    report === null ? emptyReportDraft(browserTimeZone()) : reportDraftOf(report)
  )
  const [wrong, setWrong] = useState<ReportField | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const pending = create.isPending || update.isPending
  // Made once, from the zone the form opens with: choosing another zone must not take the first one out of the list
  const [zones] = useState(() => timeZonesWith(draft.timezone))

  const set = (patch: Partial<ReportDraft>): void => {
    setDraft(current => ({ ...current, ...patch }))
    setWrong(null)
    setRefusal(null)
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const problem = reportProblem(draft)
    if (problem !== null) {
      setWrong(problem)
      return
    }
    const changes = report === null ? null : updateInputOf(report, draft)
    // Nothing changed: nothing to send
    if (changes !== null && Object.keys(changes).length === 0) {
      toast.success(t('saved'))
      onSaved()
      return
    }
    if (!guard.enter()) return
    const callbacks = {
      onSuccess: () => {
        toast.success(t(report === null ? 'created' : 'saved'))
        onSaved()
      },
      onError: (error: Error) => setRefusal(errorText(error)),
      onSettled: guard.leave
    }
    if (report === null) create.mutate(createInputOf(draft), callbacks)
    else update.mutate({ id: report.id, input: changes ?? {} }, callbacks)
  }

  const problemText = (field: ReportField): string | null =>
    wrong === field ? t(`problems.${field}`, { max: ReportLimits.MAX_RECIPIENTS }) : null
  const errorIdOf = (field: ReportField): string => `${idPrefix}-${field}-error`
  const describedBy = (field: ReportField): string | undefined =>
    wrong === field ? errorIdOf(field) : undefined
  const message = (field: ReportField): ReactElement | null => {
    const text = problemText(field)
    return text === null ? null : (
      <p id={errorIdOf(field)} role="alert" className="text-destructive text-sm">
        {text}
      </p>
    )
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3" aria-label={t('formLabel')}>
      <div className="grid gap-1.5">
        <Label htmlFor={`${idPrefix}-name`}>{t('name')}</Label>
        <Input
          id={`${idPrefix}-name`}
          value={draft.name}
          maxLength={ReportLimits.NAME_MAX_LENGTH}
          disabled={pending}
          aria-invalid={wrong === ReportFields.NAME}
          aria-describedby={describedBy(ReportFields.NAME)}
          onChange={event => set({ name: event.target.value })}
        />
        {message(ReportFields.NAME)}
      </div>
      <MetricPicker
        value={draft.metrics}
        onChange={metrics => set({ metrics })}
        disabled={pending}
        invalid={wrong === ReportFields.METRICS}
        errorId={errorIdOf(ReportFields.METRICS)}
      />
      {message(ReportFields.METRICS)}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor={`${idPrefix}-frequency`}>{t('frequency')}</Label>
          <select
            id={`${idPrefix}-frequency`}
            className={SELECT_CLASS}
            value={draft.frequency}
            disabled={pending}
            aria-invalid={wrong === ReportFields.FREQUENCY}
            aria-describedby={describedBy(ReportFields.FREQUENCY)}
            onChange={event => set({ frequency: event.target.value })}
          >
            {Object.values(ReportFrequency).map(value => (
              <option key={value} value={value}>
                {tFrequency(value)}
              </option>
            ))}
          </select>
          {message(ReportFields.FREQUENCY)}
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${idPrefix}-format`}>{t('format')}</Label>
          <select
            id={`${idPrefix}-format`}
            className={SELECT_CLASS}
            value={draft.format}
            disabled={pending}
            aria-invalid={wrong === ReportFields.FORMAT}
            aria-describedby={describedBy(ReportFields.FORMAT)}
            onChange={event => set({ format: event.target.value })}
          >
            {AnalyticsFileFormats.map(value => (
              <option key={value} value={value}>
                {tFormat(value)}
              </option>
            ))}
          </select>
          {message(ReportFields.FORMAT)}
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${idPrefix}-timezone`}>{t('timezone')}</Label>
          <select
            id={`${idPrefix}-timezone`}
            className={SELECT_CLASS}
            value={draft.timezone}
            disabled={pending}
            aria-invalid={wrong === ReportFields.TIMEZONE}
            aria-describedby={describedBy(ReportFields.TIMEZONE)}
            onChange={event => set({ timezone: event.target.value })}
          >
            {zones.map(zone => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
          {message(ReportFields.TIMEZONE)}
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${idPrefix}-hour`}>{t('hour')}</Label>
          <select
            id={`${idPrefix}-hour`}
            className={SELECT_CLASS}
            value={draft.sendAtHour}
            disabled={pending}
            onChange={event => set({ sendAtHour: Number(event.target.value) })}
          >
            {HOURS.map(hour => (
              <option key={hour} value={hour}>
                {hourLabel(hour)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p className="text-muted-foreground text-xs">{t('scheduleHint')}</p>
      <div className="grid gap-1.5">
        <Label htmlFor={`${idPrefix}-recipients`}>{t('recipients')}</Label>
        <Textarea
          id={`${idPrefix}-recipients`}
          value={draft.recipients}
          rows={3}
          disabled={pending}
          aria-invalid={wrong === ReportFields.RECIPIENTS}
          aria-describedby={describedBy(ReportFields.RECIPIENTS)}
          onChange={event => set({ recipients: event.target.value })}
        />
        <p className="text-muted-foreground text-xs">
          {t('recipientsHint', { max: ReportLimits.MAX_RECIPIENTS })}
        </p>
        {message(ReportFields.RECIPIENTS)}
      </div>
      {refusal === null ? null : (
        <p role="alert" className="text-destructive text-sm">
          {refusal}
        </p>
      )}
      <div>
        <Button type="submit" busy={pending}>
          {report === null ? t('create') : t('save')}
        </Button>
      </div>
    </form>
  )
}
