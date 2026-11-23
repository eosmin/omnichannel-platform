'use client'

import { Download, MailX } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import { ClientPermissions } from '@platform/core/auth'
import { type DsrDecision, DsrDecisions, DsrStatus, DsrType } from '@platform/core/domain'

import type { DsrRequestDetailView } from '../../lib/compliance/dsr-requests'
import {
  canApprove,
  canCancel,
  canDownloadExport,
  canReject,
  daysOverdue,
  daysLeft,
  isEndedRequest,
  isNoticeFailed,
  isOpenRequest,
  isOverdue,
  knownCodeOf,
  summaryRows
} from '../../lib/compliance/dsr-view'
import { requestDsrExportLink, useDsrRequest } from '../../lib/compliance/use-dsr'
import { useErrorText, type Translate } from '../../lib/use-error-text'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'

import { DsrDecisionForm } from './dsr-decision-form'
import { labelOf } from './dsr-labels'
import { LoadFailed, PageLoading } from './states'

// One data request in detail: what it asks, where it stands, whether the person was told how it ended, what was kept and why, and
// what the reviewer may do with it. A decision replaces the detail inside the same dialog, so there is one dialog open at a time.
export function DsrRequestDialog({
  id,
  onClose
}: {
  id: string
  onClose: () => void
}): ReactElement {
  const t = useTranslations('settings.dataRequests')
  const { storeId } = useStore()
  const request = useDsrRequest(storeId, id)
  const [decision, setDecision] = useState<DsrDecision | null>(null)
  const [busy, setBusy] = useState(false)
  const type = request.data === undefined ? null : request.data.type
  return (
    <Dialog open onOpenChange={open => (open || busy ? undefined : onClose())}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {type === null
              ? t('detail.title')
              : t('detail.titleOf', { type: labelOf(t as unknown as Translate, 'types', type) })}
          </DialogTitle>
          <DialogDescription>{t('detail.description')}</DialogDescription>
        </DialogHeader>
        {request.isError ? (
          <LoadFailed error={request.error} onRetry={() => void request.refetch()} />
        ) : request.data === undefined ? (
          <PageLoading />
        ) : decision === null ? (
          <DetailBody request={request.data} onClose={onClose} onDecide={setDecision} />
        ) : (
          <DsrDecisionForm
            request={request.data}
            decision={decision}
            onBusy={setBusy}
            onBack={() => setDecision(null)}
            onDone={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function DetailBody({
  request,
  onClose,
  onDecide
}: {
  request: DsrRequestDetailView
  onClose: () => void
  onDecide: (decision: DsrDecision) => void
}): ReactElement {
  const t = useTranslations('settings.dataRequests')
  const tl = t as unknown as Translate
  const tx = t as unknown as (key: string, values?: Record<string, string | number>) => string
  const format = useFormatter()
  const { can } = useStore()
  const mayReview = can(ClientPermissions.CUSTOMERS_DSR_REVIEW)
  const now = new Date()
  const when = (value: string): string =>
    format.dateTime(new Date(value), { dateStyle: 'medium', timeStyle: 'short' })
  const left = daysLeft(request.deadlineAt, now)
  const isErasure = request.type === String(DsrType.ERASURE)
  const failure = knownCodeOf(request.erasureFailureCode)
  const rows = summaryRows(request.retainedRecordsSummary)
  const work = request.openWork

  return (
    <div className="flex flex-col gap-4 text-sm">
      {isNoticeFailed(request) ? (
        <div
          role="alert"
          className="border-destructive/50 bg-destructive/10 flex items-start gap-2 rounded-md border p-3"
        >
          <MailX aria-hidden className="mt-0.5 size-4 shrink-0" />
          <div className="flex flex-col gap-1">
            <p className="font-medium">{t('notice.failedTitle')}</p>
            <p>{t('notice.failedBody')}</p>
          </div>
        </div>
      ) : null}

      <dl className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-[max-content_1fr]">
        <dt className="text-muted-foreground">{t('facts.status')}</dt>
        <dd>{labelOf(tl, 'statuses', request.status)}</dd>
        <dt className="text-muted-foreground">{t('facts.requested')}</dt>
        <dd>{when(request.requestedAt)}</dd>
        <dt className="text-muted-foreground">{t('facts.verified')}</dt>
        <dd>{request.verifiedAt === null ? t('facts.notVerified') : when(request.verifiedAt)}</dd>
        <dt className="text-muted-foreground">{t('facts.deadline')}</dt>
        <dd>
          {when(request.deadlineAt)}
          {isOpenRequest(request)
            ? ` · ${isOverdue(request, now) ? t('deadline.overdue', { count: daysOverdue(request.deadlineAt, now) }) : t('deadline.left', { count: left })}`
            : ''}
        </dd>
        {request.erasureDueAt !== null && request.status === String(DsrStatus.IN_PROGRESS) ? (
          <>
            <dt className="text-muted-foreground">{t('facts.erasureDue')}</dt>
            <dd>{when(request.erasureDueAt)}</dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">{t('facts.customers')}</dt>
        <dd>{t('facts.customersCount', { count: request.subjectCustomerIds.length })}</dd>
        {request.reviewedAt === null ? null : (
          <>
            <dt className="text-muted-foreground">{t('facts.reviewed')}</dt>
            <dd>{when(request.reviewedAt)}</dd>
          </>
        )}
        {request.completedAt === null ? null : (
          <>
            <dt className="text-muted-foreground">{t('facts.ended')}</dt>
            <dd>{when(request.completedAt)}</dd>
          </>
        )}
        {request.rejectionReason === null ? null : (
          <>
            <dt className="text-muted-foreground">{t('facts.rejectionReason')}</dt>
            <dd>{labelOf(tl, 'rejectionReasons', request.rejectionReason)}</dd>
          </>
        )}
        {request.notes === null ? null : (
          <>
            <dt className="text-muted-foreground">{t('facts.note')}</dt>
            <dd className="[overflow-wrap:anywhere] whitespace-pre-wrap">{request.notes}</dd>
          </>
        )}
        <dt className="text-muted-foreground">{t('facts.notice')}</dt>
        <dd>
          {isEndedRequest(request)
            ? labelOf(tl, 'notice.statuses', request.noticeStatus)
            : t('notice.notEnded')}
        </dd>
      </dl>

      {request.erasureFailureCode === null ? null : (
        <p role="note" className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3">
          <span className="font-medium">{t('failure.returned')}</span>{' '}
          {labelOf(tl, 'failure.codes', failure)}
        </p>
      )}
      {request.exportFailureCode === null ? null : (
        <p role="note" className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3">
          <span className="font-medium">{t('failure.exportFailed')}</span>{' '}
          {labelOf(tl, 'failure.codes', knownCodeOf(request.exportFailureCode))}
        </p>
      )}

      {work === null ? null : (
        <section aria-labelledby="dsr-open-work" className="flex flex-col gap-1">
          <h3 id="dsr-open-work" className="font-medium">
            {t('openWork.title')}
          </h3>
          <ul className="list-disc pl-5">
            {(['orders', 'shipments', 'returns', 'remittances', 'receivables'] as const).map(
              key => (
                <li key={key}>{t(`openWork.${key}`, { count: work[key] })}</li>
              )
            )}
          </ul>
          <p className="text-muted-foreground text-xs">{t('openWork.hint')}</p>
        </section>
      )}

      {rows.length === 0 ? null : (
        <section aria-labelledby="dsr-summary" className="flex flex-col gap-1">
          <h3 id="dsr-summary" className="font-medium">
            {isErasure ? t('summary.kept') : t('summary.holds')}
          </h3>
          <ul className="list-disc pl-5">
            {rows.map(row => (
              <li key={row.key}>{tx(`summary.counts.${row.key}`, { count: row.count })}</li>
            ))}
          </ul>
          {isErasure && request.retainedRecordsSummary?.legalBasis != null ? (
            <p className="text-muted-foreground text-xs">
              {labelOf(tl, 'summary.bases', request.retainedRecordsSummary.legalBasis)}
            </p>
          ) : null}
        </section>
      )}

      {mayReview ? (
        <Actions request={request} now={now} onClose={onClose} onDecide={onDecide} />
      ) : (
        <p className="text-muted-foreground text-xs">{t('noPermission')}</p>
      )}
    </div>
  )
}

function Actions({
  request,
  now,
  onClose,
  onDecide
}: {
  request: DsrRequestDetailView
  now: Date
  onClose: () => void
  onDecide: (decision: DsrDecision) => void
}): ReactElement {
  const t = useTranslations('settings.dataRequests')
  const { storeId } = useStore()
  const errorText = useErrorText()
  const [asking, setAsking] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  // The link is signed, lasts minutes and answers with `Content-Disposition: attachment`: the page goes to it in the same tab, which
  // downloads the file and leaves the page where it is
  const download = async (): Promise<void> => {
    setAsking(true)
    setFailure(null)
    try {
      const link = await requestDsrExportLink(storeId, request.id)
      window.location.assign(link.url)
    } catch (error) {
      setFailure(errorText(error))
    } finally {
      setAsking(false)
    }
  }

  const approvable = canApprove(request)
  const rejectable = canReject(request)
  const cancelable = canCancel(request, now)
  const downloadable = canDownloadExport(request, now)
  return (
    <div className="flex flex-col gap-2">
      {failure === null ? null : (
        <p role="alert" className="text-destructive text-sm">
          {failure}
        </p>
      )}
      {rejectable && !approvable ? (
        <p className="text-muted-foreground text-xs">{t('actions.rejectOnly')}</p>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>
          {t('actions.close')}
        </Button>
        {downloadable ? (
          <Button type="button" variant="outline" disabled={asking} onClick={() => void download()}>
            <Download aria-hidden />
            {t('actions.download')}
          </Button>
        ) : null}
        {cancelable ? (
          <Button type="button" variant="outline" onClick={() => onDecide(DsrDecisions.CANCEL)}>
            {t('actions.cancel')}
          </Button>
        ) : null}
        {rejectable ? (
          <Button type="button" variant="outline" onClick={() => onDecide(DsrDecisions.REJECT)}>
            {t('actions.reject')}
          </Button>
        ) : null}
        {approvable ? (
          <Button type="button" onClick={() => onDecide(DsrDecisions.APPROVE)}>
            {t('actions.approve')}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
