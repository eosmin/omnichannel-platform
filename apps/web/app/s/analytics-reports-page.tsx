'use client'

import { ArrowLeft, Pause, Pencil, Play, Plus, Trash2 } from 'lucide-react'
import Link from 'next/link'
import { useFormatter, useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import { AppPaths, type ReportView } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'

import { ReportDialog } from '../../components/analytics/report-dialog'
import { useStore } from '../../components/providers/store-context'
import { LoadFailed, PageLoading, PermissionDenied } from '../../components/settings/states'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '../../components/ui/alert-dialog'
import { Button } from '../../components/ui/button'
import { hourLabel } from '../../lib/analytics/report-form'
import { useDeleteReport, useReports, useUpdateReport } from '../../lib/analytics/use-reports'
import { toast } from '../../lib/toast'
import { useErrorText } from '../../lib/use-error-text'

// The scheduled reports of the store (TDD_11 §7.4): each one sends a file of the figures by email on its own clock. Seeing
// them needs analytics:manage_reports; saving or pausing one also needs analytics:export, because the report takes the figures
// of the store out by email, so the buttons are there only for whoever holds both (the api checks them again).
export function AnalyticsReportsPage(): ReactElement {
  const t = useTranslations('analytics.reports')
  const { storeId, can } = useStore()
  const allowed =
    can(ClientPermissions.ANALYTICS_VIEW) && can(ClientPermissions.ANALYTICS_MANAGE_REPORTS)
  const mayWrite = allowed && can(ClientPermissions.ANALYTICS_EXPORT)
  const reports = useReports(storeId, allowed)
  const [editing, setEditing] = useState<ReportView | null>(null)
  const [creating, setCreating] = useState(false)
  const [removing, setRemoving] = useState<ReportView | null>(null)

  if (!allowed) {
    return <PermissionDenied permission={ClientPermissions.ANALYTICS_MANAGE_REPORTS} />
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <Link
            href={AppPaths.store.analytics(storeId)}
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs"
          >
            <ArrowLeft aria-hidden className="size-3" />
            {t('back')}
          </Link>
          <h1 className="text-xl font-semibold">{t('title')}</h1>
          <p className="text-muted-foreground text-sm">{t('intro')}</p>
        </div>
        {mayWrite ? (
          <Button onClick={() => setCreating(true)}>
            <Plus aria-hidden />
            {t('create')}
          </Button>
        ) : null}
      </div>
      {mayWrite ? null : <p className="text-muted-foreground text-sm">{t('readOnly')}</p>}
      {reports.isPending ? <PageLoading /> : null}
      {reports.isError ? (
        <LoadFailed error={reports.error} onRetry={() => void reports.refetch()} />
      ) : null}
      {reports.data === undefined ? null : reports.data.length === 0 ? (
        <p className="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm">
          {t('empty')}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-left">
            <caption className="sr-only">{t('title')}</caption>
            <thead className="text-muted-foreground border-b text-xs">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t('columns.name')}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t('columns.schedule')}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t('columns.recipients')}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t('columns.lastSent')}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t('columns.state')}
                </th>
                {mayWrite ? (
                  <th scope="col" className="px-3 py-2 font-medium">
                    {t('columns.actions')}
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {reports.data.map(report => (
                <ReportRow
                  key={report.id}
                  report={report}
                  mayWrite={mayWrite}
                  onEdit={() => setEditing(report)}
                  onDelete={() => setRemoving(report)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-muted-foreground text-xs">{t('utcNote')}</p>
      <ReportDialog report={null} open={creating} onOpenChange={setCreating} />
      <ReportDialog
        report={editing}
        open={editing !== null}
        onOpenChange={open => {
          if (!open) setEditing(null)
        }}
      />
      <DeleteReportDialog report={removing} onClose={() => setRemoving(null)} />
    </div>
  )
}

function ReportRow({
  report,
  mayWrite,
  onEdit,
  onDelete
}: {
  report: ReportView
  mayWrite: boolean
  onEdit: () => void
  onDelete: () => void
}): ReactElement {
  const t = useTranslations('analytics.reports')
  const tFrequency = useTranslations('analytics.reports.frequency')
  const tFormat = useTranslations('analytics.export.formats')
  const format = useFormatter()
  const errorText = useErrorText()
  const { storeId } = useStore()
  const update = useUpdateReport(storeId)
  const [failure, setFailure] = useState<string | null>(null)

  const toggle = (): void => {
    if (update.isPending) return
    setFailure(null)
    update.mutate(
      { id: report.id, input: { enabled: !report.enabled } },
      {
        onSuccess: () =>
          toast.success(t(report.enabled ? 'paused' : 'resumed', { name: report.name })),
        onError: error => setFailure(errorText(error))
      }
    )
  }

  return (
    <tr className="border-b align-top last:border-b-0">
      <th scope="row" className="px-3 py-2 text-sm font-medium">
        {report.name}
        <span className="text-muted-foreground block text-xs font-normal">
          {t('metricCount', { count: report.metrics.length })}
        </span>
      </th>
      <td className="px-3 py-2 text-sm">
        {t('scheduleLine', {
          frequency: tFrequency.has(report.frequency as 'daily')
            ? tFrequency(report.frequency as 'daily')
            : report.frequency,
          hour: hourLabel(report.sendAtHour),
          timezone: report.timezone
        })}
        <span className="text-muted-foreground block text-xs">
          {tFormat.has(report.format as 'csv') ? tFormat(report.format as 'csv') : report.format}
        </span>
      </td>
      <td className="px-3 py-2 text-sm">
        {t('recipientCount', { count: report.recipients.length })}
        <span className="text-muted-foreground block max-w-56 truncate text-xs">
          {report.recipients.join(', ')}
        </span>
      </td>
      <td className="px-3 py-2 text-sm">
        {report.lastSentAt === null
          ? t('neverSent')
          : format.dateTime(new Date(report.lastSentAt), {
              dateStyle: 'medium',
              timeStyle: 'short'
            })}
      </td>
      <td className="px-3 py-2 text-sm">{report.enabled ? t('state.on') : t('state.off')}</td>
      {mayWrite ? (
        <td className="px-3 py-2">
          <div className="flex flex-wrap gap-1">
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('actions.edit', { name: report.name })}
              onClick={onEdit}
            >
              <Pencil aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t(report.enabled ? 'actions.pause' : 'actions.resume', {
                name: report.name
              })}
              busy={update.isPending}
              onClick={toggle}
            >
              {report.enabled ? <Pause aria-hidden /> : <Play aria-hidden />}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('actions.delete', { name: report.name })}
              onClick={onDelete}
            >
              <Trash2 aria-hidden />
            </Button>
          </div>
          {failure === null ? null : (
            <p role="alert" className="text-destructive mt-1 text-xs">
              {failure}
            </p>
          )}
        </td>
      ) : null}
    </tr>
  )
}

function DeleteReportDialog({
  report,
  onClose
}: {
  report: ReportView | null
  onClose: () => void
}): ReactElement {
  const t = useTranslations('analytics.reports.delete')
  const errorText = useErrorText()
  const { storeId } = useStore()
  const remove = useDeleteReport(storeId)
  const [failure, setFailure] = useState<string | null>(null)

  return (
    <AlertDialog
      open={report !== null}
      onOpenChange={open => {
        if (!open && !remove.isPending) {
          setFailure(null)
          onClose()
        }
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('title')}</AlertDialogTitle>
          <AlertDialogDescription>{t('body', { name: report?.name ?? '' })}</AlertDialogDescription>
        </AlertDialogHeader>
        {failure === null ? null : (
          <p role="alert" className="text-destructive text-sm">
            {failure}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={remove.isPending}>{t('cancel')}</AlertDialogCancel>
          <AlertDialogAction
            disabled={remove.isPending}
            onClick={event => {
              // The dialog stays open until the api answers: a refusal is shown in it
              event.preventDefault()
              if (report === null || remove.isPending) return
              setFailure(null)
              remove.mutate(report.id, {
                onSuccess: () => {
                  toast.success(t('done'))
                  onClose()
                },
                onError: error => setFailure(errorText(error))
              })
            }}
          >
            {t('confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
