'use client'

import { CircleAlert, CircleCheck, Pencil, Plus, SlidersHorizontal } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import type { CarrierConnectionView } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'
import { BenefitState } from '@platform/core/domain'

import { formatCents } from '../../lib/products/money'
import { bpsToPercent, periodLastDay, usedGuides } from '../../lib/settings/carrier-guides-form'
import {
  useBenefit,
  useBenefitPeriods,
  useGuideBalance,
  useGuidePolicy
} from '../../lib/settings/use-carrier-guides'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'

import {
  GuideAdjustmentDialog,
  GuidePurchaseDialog,
  GuideVoidDialog
} from './guide-movement-dialogs'
import { GuideMovements } from './guide-movements'
import { GuidePolicyDialog } from './guide-policy-dialog'
import { LoadFailed } from './states'

const STATES: readonly string[] = Object.values(BenefitState)

type Open =
  | { kind: 'purchase' }
  | { kind: 'adjustment' }
  | { kind: 'policy' }
  | { kind: 'void'; movementId: string }

// The prepaid guides of one connection: what is left, the average cost, the rate of returns of the period against the limit of
// the benefit, and the ledger. The numbers come from the api; this draws them. Writes need carriers:manage_guide_balance.
export function CarrierGuidePanel({
  connection
}: {
  connection: CarrierConnectionView
}): ReactElement {
  const t = useTranslations('settings.carriers.guides')
  const tAll = useTranslations()
  const format = useFormatter()
  const { storeId, can } = useStore()
  const canManage = can(ClientPermissions.CARRIERS_MANAGE_GUIDE_BALANCE)
  const balance = useGuideBalance(storeId, connection.id, true)
  const policy = useGuidePolicy(storeId, connection.id, true)
  const benefit = useBenefit(storeId, connection.id, true)
  const periods = useBenefitPeriods(storeId, connection.id, true)
  const [open, setOpen] = useState<Open | null>(null)
  const [showPeriods, setShowPeriods] = useState(false)

  if (balance.isError) {
    return (
      <li className="rounded-lg border p-4" aria-label={connection.displayName}>
        <LoadFailed error={balance.error} onRetry={() => void balance.refetch()} />
      </li>
    )
  }
  const view = balance.data
  const rules = policy.data
  const period = benefit.data
  const close = (): void => setOpen(null)

  return (
    <li
      data-testid="carrier-guide-panel"
      aria-label={connection.displayName}
      className="flex flex-col gap-4 rounded-lg border p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 className="font-medium break-words">{connection.displayName}</h3>
          <span className="text-muted-foreground text-sm">{connection.carrierName}</span>
        </div>
        {view === undefined || !view.tracked ? null : (
          <span
            data-testid="guide-balance-state"
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${
              view.low || view.empty ? 'border-destructive/50 text-destructive' : ''
            }`}
          >
            {view.low || view.empty ? (
              <CircleAlert aria-hidden className="size-3" />
            ) : (
              <CircleCheck aria-hidden className="size-3" />
            )}
            {view.empty ? t('state.empty') : view.low ? t('state.low') : t('state.ok')}
          </span>
        )}
      </div>

      {policy.isError || benefit.isError || periods.isError ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-destructive">{t('partialFailed')}</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              void policy.refetch()
              void benefit.refetch()
              void periods.refetch()
            }}
          >
            {tAll('common.tryAgain')}
          </Button>
        </div>
      ) : null}

      {view === undefined ? (
        <p className="text-muted-foreground text-sm">{t('loading')}</p>
      ) : !view.tracked ? (
        <p className="text-muted-foreground text-sm">{t('notTracked')}</p>
      ) : (
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat
            label={t('stats.available')}
            value={format.number(view.balance)}
            testId="guide-available"
          />
          <Stat label={t('stats.bought')} value={format.number(view.receivedGuides)} />
          <Stat label={t('stats.used')} value={format.number(usedGuides(view))} />
          <Stat
            label={t('stats.averageCost')}
            value={
              view.averageCostCents === null
                ? t('stats.none')
                : formatCents(format, view.averageCostCents)
            }
          />
        </dl>
      )}
      {view !== undefined && view.tracked && view.empty ? (
        <p role="status" className="text-sm">
          {t('emptyNote')}
        </p>
      ) : null}

      {period === undefined || !period.enabled ? (
        period !== undefined && view?.tracked ? (
          <p className="text-muted-foreground text-sm">{t('benefit.off')}</p>
        ) : null
      ) : (
        <section
          aria-label={t('benefit.title')}
          className="flex flex-col gap-2 rounded-md border p-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-sm font-medium">{t('benefit.title')}</h4>
            {period.state !== null && STATES.includes(period.state) ? (
              <span
                data-testid="benefit-state"
                className={`rounded-full border px-2 py-0.5 text-xs ${
                  period.state === BenefitState.IN_FORCE
                    ? ''
                    : 'border-destructive/50 text-destructive'
                }`}
              >
                {t(`benefit.states.${period.state}` as 'benefit.states.in_force')}
              </span>
            ) : null}
          </div>
          {period.periodStart !== null && period.periodEnd !== null ? (
            <p className="text-muted-foreground text-xs">
              {t('benefit.period', {
                start: format.dateTime(new Date(period.periodStart), { dateStyle: 'medium' }),
                end: format.dateTime(periodLastDay(period.periodEnd), { dateStyle: 'medium' })
              })}
            </p>
          ) : null}
          <p data-testid="benefit-rate" className="text-sm">
            {t('benefit.rate', {
              rate: bpsToPercent(period.rateBps),
              limit: period.thresholdBps === null ? '-' : bpsToPercent(period.thresholdBps),
              returns: period.returnCount,
              base: period.baseCount
            })}
          </p>
          {period.thresholdBps === null ? null : (
            <div
              role="progressbar"
              aria-label={t('benefit.title')}
              aria-valuemin={0}
              aria-valuemax={period.thresholdBps}
              aria-valuenow={Math.min(period.rateBps, period.thresholdBps)}
              className="bg-muted h-2 w-full overflow-hidden rounded-full"
            >
              <div
                className={`h-full ${period.state === BenefitState.IN_FORCE ? 'bg-primary' : 'bg-destructive'}`}
                style={{ width: `${Math.min(100, (period.rateBps * 100) / period.thresholdBps)}%` }}
              />
            </div>
          )}
          {rules !== undefined && rules.toConfirm.length > 0 ? (
            <p className="text-muted-foreground text-xs">{t('benefit.toConfirm')}</p>
          ) : null}
          {periods.data !== undefined && periods.data.length > 0 ? (
            <div className="flex flex-col gap-2">
              <div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-expanded={showPeriods}
                  onClick={() => setShowPeriods(shown => !shown)}
                >
                  {showPeriods ? t('benefit.hideHistory') : t('benefit.showHistory')}
                </Button>
              </div>
              {showPeriods ? (
                <ul
                  aria-label={t('benefit.history')}
                  className="flex flex-col divide-y rounded-md border"
                >
                  {periods.data.map(item => (
                    <li
                      key={item.periodStart}
                      className="flex flex-wrap items-center justify-between gap-2 p-2 text-xs"
                    >
                      <span>
                        {format.dateTime(new Date(item.periodStart), { dateStyle: 'medium' })} -{' '}
                        {format.dateTime(periodLastDay(item.periodEnd), { dateStyle: 'medium' })}
                      </span>
                      <span>
                        {t('benefit.closedRow', {
                          rate: bpsToPercent(item.rateBps),
                          refunded: item.refundedCount,
                          state: STATES.includes(item.state)
                            ? t(`benefit.states.${item.state}` as 'benefit.states.in_force')
                            : item.state
                        })}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </section>
      )}

      {canManage ? (
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" onClick={() => setOpen({ kind: 'purchase' })}>
            <Plus aria-hidden />
            {t('actions.purchase')}
            <span className="sr-only"> {connection.displayName}</span>
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setOpen({ kind: 'adjustment' })}
          >
            <SlidersHorizontal aria-hidden />
            {t('actions.adjustment')}
            <span className="sr-only"> {connection.displayName}</span>
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={rules === undefined}
            onClick={() => setOpen({ kind: 'policy' })}
          >
            <Pencil aria-hidden />
            {t('actions.policy')}
            <span className="sr-only"> {connection.displayName}</span>
          </Button>
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        <h4 className="text-sm font-medium">{t('movements.title')}</h4>
        <GuideMovements
          connectionId={connection.id}
          canManage={canManage}
          onVoid={movementId => setOpen({ kind: 'void', movementId })}
        />
      </div>

      {open?.kind === 'purchase' ? (
        <GuidePurchaseDialog
          connectionId={connection.id}
          connectionName={connection.displayName}
          chargeModel={connection.chargeModel}
          onClose={close}
        />
      ) : null}
      {open?.kind === 'adjustment' ? (
        <GuideAdjustmentDialog
          connectionId={connection.id}
          connectionName={connection.displayName}
          onClose={close}
        />
      ) : null}
      {open?.kind === 'void' ? (
        <GuideVoidDialog
          connectionId={connection.id}
          connectionName={connection.displayName}
          movementId={open.movementId}
          onClose={close}
        />
      ) : null}
      {open?.kind === 'policy' && rules !== undefined ? (
        <GuidePolicyDialog
          connectionId={connection.id}
          connectionName={connection.displayName}
          policy={rules}
          onClose={close}
        />
      ) : null}
    </li>
  )
}

function Stat({
  label,
  value,
  testId
}: {
  label: string
  value: string
  testId?: string
}): ReactElement {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd data-testid={testId} className="text-lg font-semibold tabular-nums">
        {value}
      </dd>
    </div>
  )
}
