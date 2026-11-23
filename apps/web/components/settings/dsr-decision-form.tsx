'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useEffect, useId, useState } from 'react'

import { ApiError } from '@platform/api-client'
import {
  type DestructiveAction,
  type DsrDecision,
  DsrDecisions,
  DsrReviewLimits,
  DsrType
} from '@platform/core/domain'
import { ClientErrorCodes } from '@platform/core/errors'

import type { DsrRequestDetailView } from '../../lib/compliance/dsr-requests'
import { canApprove, canCancel, canReject, reasonProblem } from '../../lib/compliance/dsr-view'
import { useDsrDecision } from '../../lib/compliance/use-dsr'
import { useSubmitGuard } from '../../lib/submit-guard'
import { toast } from '../../lib/toast'
import { useErrorText } from '../../lib/use-error-text'
import { useStore } from '../providers/store-context'
import { useDestructiveAction } from '../shared/destructive-action'
import { Button } from '../ui/button'
import { CharCounter } from '../ui/char-counter'
import { stickyDialogActionsClass } from '../ui/dialog'
import { Label } from '../ui/label'
import { Textarea } from '../ui/textarea'

const ACTIONS: Record<DsrDecision, DestructiveAction> = {
  [DsrDecisions.APPROVE]: 'APPROVE_DSR_REQUEST',
  [DsrDecisions.REJECT]: 'REJECT_DSR_REQUEST',
  [DsrDecisions.CANCEL]: 'CANCEL_DSR_ERASURE'
}

// The counts a refusal for open work carries (`metadata`), when the api sends them
const WORK_KEYS = ['orders', 'shipments', 'returns', 'remittances', 'receivables'] as const

// What each decision does, by the key of its text. The kind of an approval depends on the request: an erasure waits and a file is made
type DecisionKind = 'approveErasure' | 'approveExport' | 'reject' | 'cancel'
const EFFECTS: Record<DecisionKind, readonly string[]> = {
  approveErasure: ['grace', 'final', 'mail'],
  approveExport: ['file', 'download', 'mail'],
  reject: ['mail', 'final', 'reason'],
  cancel: ['stops', 'mail', 'final']
}
// What an erasure keeps and why (the same list the closing summary counts)
const KEPT = ['orders', 'conversations', 'fiscal', 'consents', 'copied'] as const

// A decision on a data request: what it does is said BEFORE it is asked for (what is erased, what is kept and why, what the person is
// told), the reason is written, and the action asks to be confirmed again. The reason is text about a person: the api keeps it in the
// request and never copies it to the audit log.
export function DsrDecisionForm({
  request,
  decision,
  onBusy,
  onBack,
  onDone
}: {
  request: DsrRequestDetailView
  decision: DsrDecision
  onBusy: (busy: boolean) => void
  onBack: () => void
  onDone: () => void
}): ReactElement {
  const tTyped = useTranslations('settings.dataRequests.decision')
  // The texts are chosen by the kind of decision, so their keys are built: said loosely, a spec holds that every one exists
  const t = tTyped as unknown as (key: string, values?: Record<string, string | number>) => string
  const errorText = useErrorText()
  const run = useDestructiveAction()
  const { storeId } = useStore()
  const guard = useSubmitGuard()
  const mutation = useDsrDecision(storeId, decision)
  const idPrefix = useId()
  const [reason, setReason] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [showProblem, setShowProblem] = useState(false)
  const [refusal, setRefusal] = useState<ApiError | Error | null>(null)
  const isErasure = request.type === String(DsrType.ERASURE)
  // The api refuses an erasure of a customer with open work; the screen says so before, and still shows the api's word if it comes
  const work = request.openWork
  const blocked =
    decision === DsrDecisions.APPROVE && work !== null && WORK_KEYS.some(key => work[key] > 0)
  const problem = reasonProblem(reason)
  // The request is read again after every refusal: if someone decided first, this decision no longer fits it and is not offered again
  const allowed =
    decision === DsrDecisions.APPROVE
      ? canApprove(request)
      : decision === DsrDecisions.REJECT
        ? canReject(request)
        : canCancel(request, new Date())
  const needsConfirm = decision === DsrDecisions.APPROVE
  // The kind of effects the dialog lists: an erasure and an export say different things
  const kind: DecisionKind =
    decision === DsrDecisions.APPROVE ? (isErasure ? 'approveErasure' : 'approveExport') : decision

  useEffect(() => {
    onBusy(mutation.isPending)
    return () => onBusy(false)
  }, [mutation.isPending, onBusy])

  const send = async (): Promise<void> => {
    if (!guard.enter()) return
    setRefusal(null)
    try {
      await mutation.mutateAsync({ id: request.id, reason: reason.trim() })
      toast.success(t(`${kind}.done`))
      onDone()
    } catch (error) {
      setRefusal(error instanceof Error ? error : new Error())
    } finally {
      guard.leave()
    }
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (mutation.isPending || !allowed) return
    if (problem !== null || (needsConfirm && !confirmed)) {
      setShowProblem(true)
      return
    }
    run(ACTIONS[decision], {
      title: t(`${kind}.confirmTitle`),
      description: t(`${kind}.confirmDescription`),
      confirmLabel: t(`${kind}.confirm`),
      onConfirm: send
    })
  }

  const counts =
    refusal instanceof ApiError && refusal.code === ClientErrorCodes.DSR_BLOCKED_BY_OPEN_WORK
      ? WORK_KEYS.flatMap(key => {
          const value = refusal.metadata[key]
          return typeof value === 'number' && value > 0 ? [{ key, count: value }] : []
        })
      : []
  const reasonId = `${idPrefix}-reason`
  const confirmId = `${idPrefix}-confirm`

  return (
    <form
      onSubmit={submit}
      noValidate
      className="flex flex-col gap-3"
      aria-label={t(`${kind}.title`)}
    >
      <h3 className="font-medium">{t(`${kind}.title`)}</h3>
      <div className="bg-muted/50 flex flex-col gap-2 rounded-md border p-3 text-sm">
        <p className="font-medium">{t('effectsTitle')}</p>
        <ul className="text-muted-foreground list-disc pl-5">
          {EFFECTS[kind].map(key => (
            <li key={key}>
              {t(`${kind}.effects.${key}`, { days: DsrReviewLimits.ERASURE_GRACE_DAYS })}
            </li>
          ))}
        </ul>
        {kind === 'approveErasure' ? (
          <>
            <p className="font-medium">{t('keptTitle')}</p>
            <ul className="text-muted-foreground list-disc pl-5">
              {KEPT.map(key => (
                <li key={key}>{t(`kept.${key}`)}</li>
              ))}
            </ul>
          </>
        ) : null}
      </div>

      {allowed ? null : (
        <p role="alert" className="text-destructive text-sm">
          {t('stale')}
        </p>
      )}
      {blocked ? (
        <p role="alert" className="text-destructive text-sm">
          {t('blocked')}
        </p>
      ) : null}

      <div className="grid grid-cols-1 gap-1.5">
        <Label htmlFor={reasonId}>{t('reason')}</Label>
        <Textarea
          id={reasonId}
          value={reason}
          rows={4}
          maxLength={DsrReviewLimits.REASON_MAX_LENGTH * 2}
          disabled={mutation.isPending}
          aria-invalid={showProblem && problem !== null}
          aria-describedby={`${reasonId}-hint${showProblem && problem !== null ? ` ${reasonId}-error` : ''}`}
          onChange={event => setReason(event.target.value)}
        />
        <p id={`${reasonId}-hint`} className="text-muted-foreground text-xs">
          {t('reasonHint')}
        </p>
        <CharCounter length={reason.length} max={DsrReviewLimits.REASON_MAX_LENGTH} />
        {showProblem && problem !== null ? (
          <p id={`${reasonId}-error`} role="alert" className="text-destructive text-sm">
            {t(`problems.${problem}`, { max: DsrReviewLimits.REASON_MAX_LENGTH })}
          </p>
        ) : null}
      </div>

      {needsConfirm ? (
        <div className="flex flex-col gap-1">
          <label htmlFor={confirmId} className="flex items-start gap-2 text-sm">
            <input
              id={confirmId}
              type="checkbox"
              className="mt-0.5"
              checked={confirmed}
              disabled={mutation.isPending}
              aria-invalid={showProblem && !confirmed}
              onChange={event => setConfirmed(event.target.checked)}
            />
            <span>{t(`${kind}.acknowledge`)}</span>
          </label>
          {showProblem && !confirmed ? (
            <p role="alert" className="text-destructive text-sm">
              {t('problems.confirm')}
            </p>
          ) : null}
        </div>
      ) : null}

      {refusal === null ? null : (
        <div role="alert" className="text-destructive text-sm">
          <p>{errorText(refusal)}</p>
          {counts.length === 0 ? null : (
            <ul className="list-disc pl-5">
              {counts.map(item => (
                <li key={item.key}>{t(`openWorkLine.${item.key}`, { count: item.count })}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className={`${stickyDialogActionsClass} flex justify-end gap-2`}>
        <Button type="button" variant="outline" onClick={onBack} disabled={mutation.isPending}>
          {t('back')}
        </Button>
        <Button
          type="submit"
          variant={decision === DsrDecisions.APPROVE ? 'default' : 'destructive'}
          disabled={mutation.isPending || blocked || !allowed}
        >
          {mutation.isPending ? t('sending') : t(`${kind}.submit`)}
        </Button>
      </div>
    </form>
  )
}
