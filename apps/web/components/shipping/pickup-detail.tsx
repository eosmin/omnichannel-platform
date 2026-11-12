'use client'

import { Printer } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import { type ReactElement, useMemo, useState } from 'react'

import { ApiError, type PickupChangeView, type PickupView } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'
import { PickupFailureNotes, PickupStatus, ShipmentStatus } from '@platform/core/domain'
import { ClientErrorCodes } from '@platform/core/errors'

import { isKnown } from '../../lib/shipping/known-value'
import { isEligibleForPickup, pickupActions } from '../../lib/shipping/shipping-rules'
import {
  useAddPickupShipments,
  useCancelPickup,
  useConfirmPickup,
  usePickupManifest,
  useRemovePickupShipment,
  useShipmentList
} from '../../lib/shipping/use-shipping-screens'
import { toast } from '../../lib/toast'
import { useErrorText } from '../../lib/use-error-text'
import { useStore } from '../providers/store-context'
import { LoadFailed, PageLoading } from '../settings/states'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '../ui/alert-dialog'
import { Button } from '../ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../ui/sheet'

const NONE: readonly never[] = []

// What a pickup says went wrong: a name the platform wrote (translated here), or the carrier's own line (shown as it came)
export function PickupFailureText({ error }: { error: string }): ReactElement {
  const t = useTranslations('pickups.failure')
  const isNote = isKnown(PickupFailureNotes, error)
  return <>{isNote ? t(error as 'carrier_unavailable') : error}</>
}

export function PickupStatusText({ status }: { status: string }): ReactElement {
  const t = useTranslations('pickups.status')
  return <>{isKnown(PickupStatus, status) ? t(status as 'requested') : t('unknown')}</>
}

// The guides of a connection that are made, outbound and in no pickup: the ones that can join
function EligibleGuides({
  pickup,
  onJoined
}: {
  pickup: PickupView
  onJoined: (answer: PickupChangeView) => void
}): ReactElement {
  const t = useTranslations('pickups.detail.join')
  const errorText = useErrorText()
  const { storeId } = useStore()
  const list = useShipmentList(
    storeId,
    { status: ShipmentStatus.LABEL_CREATED, connectionId: pickup.connectionId },
    true
  )
  const add = useAddPickupShipments(storeId)
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [refusal, setRefusal] = useState<string | null>(null)
  const [needsCutoffOk, setNeedsCutoffOk] = useState(false)
  const eligible = useMemo(
    () =>
      (list.data?.pages.flatMap(page => page.data) ?? NONE).filter(guide =>
        isEligibleForPickup(guide, pickup.connectionId)
      ),
    [list.data, pickup.connectionId]
  )
  // A guide that left the list (joined elsewhere, voided) is no longer chosen: the count and the request follow what is shown
  const chosen = eligible.filter(guide => picked.has(guide.id)).map(guide => guide.id)
  const toggle = (id: string): void =>
    setPicked(current => {
      const next = new Set(current)
      if (!next.delete(id)) next.add(id)
      return next
    })
  const join = (confirmAfterCutoff: boolean): void => {
    setRefusal(null)
    add.mutate(
      {
        pickupId: pickup.id,
        shipmentIds: chosen,
        ...(confirmAfterCutoff ? { confirmAfterCutoff: true } : {})
      },
      {
        onSuccess: answer => {
          setPicked(new Set())
          setNeedsCutoffOk(false)
          onJoined(answer)
        },
        onError: error => {
          if (error instanceof ApiError && error.is(ClientErrorCodes.PICKUP_CUTOFF_PASSED)) {
            setNeedsCutoffOk(true)
            return
          }
          setRefusal(errorText(error))
        }
      }
    )
  }
  return (
    <section aria-labelledby="pickup-join" className="flex flex-col gap-2">
      <h3 id="pickup-join" className="text-sm font-semibold">
        {t('title')}
      </h3>
      {list.isPending ? <PageLoading /> : null}
      {list.isSuccess && eligible.length === 0 && !list.hasNextPage ? (
        <p className="text-muted-foreground text-sm">{t('none')}</p>
      ) : null}
      {eligible.length === 0 ? null : (
        <ul className="flex flex-col">
          {eligible.map(guide => (
            <li key={guide.id} className="border-b py-1">
              <label className="flex items-center gap-2 text-sm pointer-coarse:min-h-10">
                <input
                  type="checkbox"
                  className="size-4 accent-current pointer-coarse:size-5"
                  checked={picked.has(guide.id)}
                  onChange={() => toggle(guide.id)}
                />
                <span>
                  {guide.guideNumber ?? guide.orderNumber} ·{' '}
                  {t('orderNumber', { number: guide.orderNumber })}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {list.hasNextPage ? (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          busy={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          {t('loadMore')}
        </Button>
      ) : null}
      {needsCutoffOk ? (
        <p role="alert" className="text-sm font-medium text-amber-700 dark:text-amber-300">
          {t('cutoffPassed')}
        </p>
      ) : null}
      {refusal === null ? null : (
        <p role="alert" className="text-destructive text-sm">
          {refusal}
        </p>
      )}
      <Button
        size="sm"
        className="self-start"
        disabled={chosen.length === 0 || add.isPending}
        busy={add.isPending}
        onClick={() => join(needsCutoffOk)}
      >
        {needsCutoffOk
          ? t('addAnyway', { count: chosen.length })
          : t('add', { count: chosen.length })}
      </Button>
    </section>
  )
}

// One pickup: what it is, the guides it holds (the manifest, printable) and what a person may do with it
export function PickupDetail({
  pickup,
  capabilities,
  onChanged,
  onClose
}: {
  pickup: PickupView
  capabilities: readonly string[] | null
  // The pickup as the server says it after a change, for the page to keep when the list no longer holds it
  onChanged: (pickup: PickupView) => void
  onClose: () => void
}): ReactElement {
  const t = useTranslations('pickups.detail')
  const tReason = useTranslations('orders.bulk.report.reasons')
  const format = useFormatter()
  const errorText = useErrorText()
  const { storeId, can } = useStore()
  const manifest = usePickupManifest(storeId, pickup.id)
  const confirm = useConfirmPickup(storeId)
  const cancel = useCancelPickup(storeId)
  const remove = useRemovePickupShipment(storeId)
  const [askCancel, setAskCancel] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [waiting, setWaiting] = useState<PickupChangeView['waiting']>([])
  const actions = pickupActions(pickup, {
    canManage: can(ClientPermissions.SHIPPING_MANAGE),
    canManagePickups: can(ClientPermissions.SHIPPING_MANAGE_PICKUPS),
    capabilities
  })
  const lines = manifest.data?.lines ?? NONE
  const run = (mutation: typeof confirm, done: string): void => {
    setRefusal(null)
    mutation.mutate(pickup.id, {
      onSuccess: view => {
        toast.success(done)
        onChanged(view)
      },
      onError: error => setRefusal(errorText(error))
    })
  }
  const day = new Date(`${pickup.pickupDate}T00:00:00Z`)
  return (
    <Sheet open onOpenChange={next => (next ? undefined : onClose())}>
      <SheetContent className="print:static print:w-full print:max-w-none print:border-0 print:shadow-none">
        <SheetHeader>
          <SheetTitle>
            {t('title', {
              carrier: pickup.connectionName,
              day: Number.isNaN(day.getTime())
                ? pickup.pickupDate
                : format.dateTime(day, { dateStyle: 'medium', timeZone: 'UTC' })
            })}
          </SheetTitle>
          <SheetDescription>
            <PickupStatusText status={pickup.status} />
            {pickup.windowStart !== null && pickup.windowEnd !== null
              ? ` · ${t('window', { from: pickup.windowStart, to: pickup.windowEnd })}`
              : ''}
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
          {actions.needsPerson ? (
            <p role="note" className="text-sm font-medium text-amber-700 dark:text-amber-300">
              {t(
                pickup.status === String(PickupStatus.REQUIRES_REVIEW)
                  ? 'needsReview'
                  : 'needsManual'
              )}
            </p>
          ) : null}
          {pickup.lastError === null ? null : (
            <p role="note" className="text-sm">
              {t('lastError')} <PickupFailureText error={pickup.lastError} />
            </p>
          )}
          {actions.cancelWithCarrier ? (
            <p role="note" className="text-sm">
              {t('cancelWithCarrier')}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2 print:hidden">
            {actions.manifest ? (
              <Button variant="outline" size="sm" onClick={() => window.print()}>
                <Printer aria-hidden />
                {t('actions.print')}
              </Button>
            ) : null}
            {actions.confirm ? (
              <Button
                size="sm"
                busy={confirm.isPending}
                onClick={() => run(confirm, t('confirmed'))}
              >
                {t('actions.confirm')}
              </Button>
            ) : null}
            {actions.cancel ? (
              <Button variant="outline" size="sm" onClick={() => setAskCancel(true)}>
                {t('actions.cancel')}
              </Button>
            ) : null}
          </div>
          {refusal === null ? null : (
            <p role="alert" className="text-destructive text-sm">
              {refusal}
            </p>
          )}
          <section aria-labelledby="pickup-manifest">
            <h3 id="pickup-manifest" className="text-sm font-semibold">
              {t('manifest', { count: manifest.data?.packageCount ?? pickup.packageCount })}
            </h3>
            {manifest.isPending ? <PageLoading /> : null}
            {manifest.isError ? (
              <LoadFailed error={manifest.error} onRetry={() => void manifest.refetch()} />
            ) : null}
            {manifest.isSuccess && lines.length === 0 ? (
              <p className="text-muted-foreground text-sm">{t('noGuides')}</p>
            ) : null}
            {lines.length === 0 ? null : (
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b text-sm">
                    <th className="py-2 pr-3 font-medium">{t('columns.guide')}</th>
                    <th className="py-2 pr-3 font-medium">{t('columns.order')}</th>
                    <th className="py-2 pr-3 font-medium">{t('columns.recipient')}</th>
                    <th className="py-2 pr-3 font-medium">{t('columns.packages')}</th>
                    <th className="py-2 print:hidden">
                      <span className="sr-only">{t('columns.actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map(line => (
                    <tr key={line.shipmentId} className="border-b text-sm">
                      <td className="py-2 pr-3 whitespace-nowrap">
                        {line.guideNumber ?? t('noGuide')}
                      </td>
                      <td className="py-2 pr-3 whitespace-nowrap">
                        {t('orderNumber', { number: line.orderNumber })}
                      </td>
                      <td className="py-2 pr-3">{line.recipient}</td>
                      <td className="py-2 pr-3">{line.packageCount}</td>
                      <td className="py-2 text-right print:hidden">
                        {actions.edit ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={remove.isPending}
                            aria-label={t('removeGuide', {
                              guide: line.guideNumber ?? line.orderNumber
                            })}
                            onClick={() => {
                              setRefusal(null)
                              remove.mutate(
                                { pickupId: pickup.id, shipmentId: line.shipmentId },
                                {
                                  onSuccess: view => onChanged(view),
                                  onError: error => setRefusal(errorText(error))
                                }
                              )
                            }}
                          >
                            {t('remove')}
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
          {waiting.length === 0 ? null : (
            <ul role="status" className="text-sm print:hidden">
              {waiting.map(item => (
                <li key={item.shipmentId}>
                  {tReason.has(item.reason as 'unknown')
                    ? tReason(item.reason as 'cutoff_passed')
                    : tReason('unknown')}
                </li>
              ))}
            </ul>
          )}
          {actions.edit ? (
            <div className="print:hidden">
              <EligibleGuides
                pickup={pickup}
                onJoined={answer => {
                  setWaiting(answer.waiting)
                  onChanged(answer.pickup)
                }}
              />
            </div>
          ) : null}
        </div>
        <AlertDialog open={askCancel} onOpenChange={setAskCancel}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('cancelDialog.title')}</AlertDialogTitle>
              <AlertDialogDescription>{t('cancelDialog.description')}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={cancel.isPending}>
                {t('cancelDialog.keep')}
              </AlertDialogCancel>
              <Button
                variant="destructive"
                busy={cancel.isPending}
                onClick={() => {
                  setAskCancel(false)
                  run(cancel, t('cancelled'))
                }}
              >
                {t('cancelDialog.confirm')}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </SheetContent>
    </Sheet>
  )
}
