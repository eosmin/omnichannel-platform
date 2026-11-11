'use client'

import { ArrowLeft } from 'lucide-react'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { useFormatter, useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import { AppPaths, type CountDetailView } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'
import { CountStatus } from '@platform/core/domain'

import { CountApplyRefusal } from '../../components/counts/count-apply-refusal'
import { CountReviewPanel } from '../../components/counts/count-review-panel'
import { CountSheetPanel } from '../../components/counts/count-sheet-panel'
import { CountStatusBadge } from '../../components/counts/count-status-badge'
import { MutationError } from '../../components/customers/mutation-error'
import { useStore } from '../../components/providers/store-context'
import { LoadFailed, PageLoading, PermissionDenied } from '../../components/settings/states'
import { useDestructiveAction } from '../../components/shared/destructive-action'
import { Button } from '../../components/ui/button'
import { applyRefusalOf, conflictOf } from '../../lib/counts/count-conflict'
import { isCountId } from '../../lib/counts/count-id'
import { type CountSaver, SaverStates, useCountSaver } from '../../lib/counts/use-count-saver'
import { CountActions, useCountAction, useCountSheet } from '../../lib/counts/use-counts'
import { toast } from '../../lib/toast'
import { useErrorText } from '../../lib/use-error-text'
import { useProfile } from '../../lib/use-profile'

const COUNT_PERMISSIONS = [
  ClientPermissions.INVENTORY_MANAGE_COUNTS,
  ClientPermissions.INVENTORY_APPLY_COUNTS
] as const

// One count (TDD_16 §4.6, §7): made, started, counted, reviewed and applied from here. Counting needs
// inventory:manage_counts, applying needs inventory:apply_counts; the reading and the way back to counting take either.
// The buttons follow the permissions of the person; the api decides every request.
export function CountPage({ countId }: { countId: string }): ReactElement {
  const { can } = useStore()
  // An address that is not the id of a count is a page that does not exist; it never reaches a request
  if (!isCountId(countId)) notFound()
  return COUNT_PERMISSIONS.some(permission => can(permission)) ? (
    <Count key={countId} countId={countId} />
  ) : (
    <PermissionDenied anyOf={COUNT_PERMISSIONS} />
  )
}

function Count({ countId }: { countId: string }): ReactElement {
  const { storeId } = useStore()
  const sheet = useCountSheet(storeId, countId)
  const counting = sheet.data?.status === CountStatus.COUNTING
  // The quantities typed live in the saver while the count is being counted; the lines of the api under them
  const profile = useProfile()
  const saver = useCountSaver(
    storeId,
    profile.data?.id,
    countId,
    counting ? sheet.data?.lines : undefined
  )
  // A read that fails behind a sheet already on the screen (the signal is lost in the aisle) leaves the sheet where it is
  if (sheet.data === undefined) {
    return sheet.isError ? (
      <LoadFailed error={sheet.error} onRetry={() => void sheet.refetch()} />
    ) : (
      <PageLoading />
    )
  }
  return <CountSheet count={sheet.data} saver={saver} />
}

function CountSheet({ count, saver }: { count: CountDetailView; saver: CountSaver }): ReactElement {
  const t = useTranslations('counts')
  const tAll = useTranslations()
  const format = useFormatter()
  const { storeId, can } = useStore()
  const run = useDestructiveAction()
  const errorText = useErrorText()
  const action = useCountAction(storeId, count.id)
  const [notSaved, setNotSaved] = useState(false)
  const [applyError, setApplyError] = useState<unknown>(null)
  const canCount = can(ClientPermissions.INVENTORY_MANAGE_COUNTS)
  const canApply = can(ClientPermissions.INVENTORY_APPLY_COUNTS)
  const canReopenOrCancel = canCount || canApply
  const refusal = applyRefusalOf(applyError)
  const when = (iso: string | null): string | null =>
    iso === null
      ? null
      : format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' })

  const perform = (kind: (typeof CountActions)[keyof typeof CountActions]): void => {
    setNotSaved(false)
    setApplyError(null)
    action.reset()
    action.mutate(kind)
  }

  // The quantities on the screen go to the api first: a count is never sent for review with some of them left on the phone
  const submit = async (): Promise<void> => {
    setNotSaved(false)
    if (await saver.flush()) perform(CountActions.SUBMIT)
    else setNotSaved(true)
  }

  const apply = (): void =>
    run('APPLY_STOCK_COUNT', {
      title: t('apply.title', { number: count.number }),
      description: t('apply.description', { warehouse: count.warehouse.name }),
      confirmLabel: t('apply.confirm'),
      onConfirm: async () => {
        setApplyError(null)
        action.reset()
        try {
          await action.mutateAsync(CountActions.APPLY)
          toast.success(t('apply.done'))
        } catch (error) {
          // The refusal is explained on the page, line by line; the dialog closes
          setApplyError(error)
        }
      }
    })

  const cancel = (): void =>
    run('CANCEL_STOCK_COUNT', {
      title: t('cancel.title', { number: count.number }),
      description: t(
        count.status === CountStatus.DRAFT ? 'cancel.descriptionDraft' : 'cancel.description'
      ),
      confirmLabel: t('cancel.confirm'),
      onConfirm: async () => {
        setApplyError(null)
        action.reset()
        try {
          await action.mutateAsync(CountActions.CANCEL)
        } catch {
          // The reason is shown on the page (`action.error`)
        }
      }
    })

  const conflict = conflictOf(action.error)
  const conflictKey = conflict === null ? null : `counts.conflicts.${conflict}`
  const busy = action.isPending
  const open =
    count.status === CountStatus.DRAFT ||
    count.status === CountStatus.COUNTING ||
    count.status === CountStatus.REVIEW

  return (
    <section className="flex max-w-3xl flex-col gap-4">
      <Link
        href={AppPaths.org.counts}
        className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-sm pointer-coarse:min-h-10"
      >
        <ArrowLeft aria-hidden className="size-4" />
        {t('back')}
      </Link>
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold">{count.number}</h1>
          <CountStatusBadge status={count.status} />
        </div>
        <p className="text-sm">
          {count.warehouse.code} · {count.warehouse.name}
        </p>
        <p className="text-muted-foreground text-sm">
          {count.storeName === null ? t('scopeAll') : t('scopeStore', { store: count.storeName })}
        </p>
        {count.note !== null ? <p className="text-sm">{count.note}</p> : null}
        <p className="text-muted-foreground text-xs">
          {[
            t('createdAt', { date: when(count.createdAt) ?? '' }),
            count.startedAt === null ? null : t('startedAt', { date: when(count.startedAt) ?? '' }),
            count.appliedAt === null ? null : t('appliedAt', { date: when(count.appliedAt) ?? '' })
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </header>

      {count.status === CountStatus.DRAFT ? <p className="text-sm">{t('draftNote')}</p> : null}
      {count.status === CountStatus.COUNTING ? (
        <CountSheetPanel lines={count.lines} saver={saver} canCount={canCount} />
      ) : null}
      {count.status === CountStatus.REVIEW || count.status === CountStatus.APPLIED ? (
        <CountReviewPanel
          lines={count.lines}
          applied={count.status === CountStatus.APPLIED}
          refusal={refusal}
        />
      ) : null}
      {count.status === CountStatus.CANCELLED ? (
        <p role="status" className="text-muted-foreground text-sm">
          {t('cancelledNote')}
        </p>
      ) : null}
      {count.status !== CountStatus.DRAFT && count.status !== CountStatus.CANCELLED ? (
        <p className="text-muted-foreground text-xs">{t('totalsNote')}</p>
      ) : null}

      {refusal !== null ? (
        <CountApplyRefusal
          refusal={refusal}
          lines={count.lines}
          canReopen={canReopenOrCancel}
          reopening={busy}
          onReopen={() => perform(CountActions.REOPEN)}
        />
      ) : applyError !== null ? (
        <p role="alert" className="text-destructive text-sm">
          {errorText(applyError)}
        </p>
      ) : null}
      {notSaved ? (
        <p role="alert" className="text-destructive text-sm">
          {t('sheet.save.notSent')}
        </p>
      ) : null}
      {conflictKey !== null && tAll.has(conflictKey as 'counts.title') ? (
        <p role="alert" className="text-destructive text-sm">
          {tAll(conflictKey as 'counts.title')}
        </p>
      ) : (
        <MutationError error={action.error} />
      )}
      {count.status === CountStatus.REVIEW ? (
        <p className="text-sm">{t('review.applyWho')}</p>
      ) : null}

      {open ? (
        <div className="bg-background sticky bottom-0 flex flex-wrap items-center justify-end gap-2 border-t py-3">
          {canReopenOrCancel ? (
            <Button variant="outline" onClick={cancel} disabled={busy}>
              {t('actions.cancel')}
            </Button>
          ) : null}
          {count.status === CountStatus.DRAFT && canCount ? (
            <Button onClick={() => perform(CountActions.START)} busy={busy}>
              {t('actions.start')}
            </Button>
          ) : null}
          {count.status === CountStatus.COUNTING && canCount ? (
            <Button
              onClick={() => void submit()}
              busy={busy || saver.state === SaverStates.SAVING}
              disabled={saver.state === SaverStates.REFUSED}
            >
              {t('actions.submit')}
            </Button>
          ) : null}
          {count.status === CountStatus.REVIEW && canReopenOrCancel ? (
            <Button variant="outline" onClick={() => perform(CountActions.REOPEN)} busy={busy}>
              {t('actions.reopen')}
            </Button>
          ) : null}
          {count.status === CountStatus.REVIEW && canApply ? (
            <Button onClick={apply} disabled={busy}>
              {t('actions.apply')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
