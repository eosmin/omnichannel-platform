'use client'

import { useFormatter, useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { GuideMovementKind } from '@platform/core/domain'

import { formatCents } from '../../lib/products/money'
import { useGuideMovements } from '../../lib/settings/use-carrier-guides'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'

import { LoadFailed } from './states'

const KINDS: readonly string[] = Object.values(GuideMovementKind)

// The movements of the ledger of one connection, newest first (TDD_17 §4.18): a purchase, a guide used, a guide given back, an
// adjustment, a void. The ledger only grows: a mistaken purchase is voided, never edited.
export function GuideMovements({
  connectionId,
  canManage,
  onVoid
}: {
  connectionId: string
  canManage: boolean
  onVoid: (movementId: string) => void
}): ReactElement {
  const t = useTranslations('settings.carriers.guides.movements')
  const format = useFormatter()
  const { storeId } = useStore()
  const movements = useGuideMovements(storeId, connectionId, true)

  if (movements.isError) {
    return <LoadFailed error={movements.error} onRetry={() => void movements.refetch()} />
  }
  if (movements.data === undefined) {
    return <p className="text-muted-foreground text-sm">{t('loading')}</p>
  }
  const rows = movements.data.pages.flatMap(page => page.data)
  if (rows.length === 0) return <p className="text-muted-foreground text-sm">{t('empty')}</p>

  return (
    <div className="flex flex-col gap-2">
      <ul aria-label={t('label')} className="flex flex-col divide-y rounded-md border">
        {rows.map(row => (
          <li
            key={row.id}
            data-testid="guide-movement"
            className="flex flex-wrap items-start justify-between gap-2 p-3 text-sm"
          >
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="font-medium">
                {KINDS.includes(row.kind) ? t(`kinds.${row.kind}` as 'kinds.purchase') : row.kind}
                {row.voided ? ` · ${t('voided')}` : ''}
              </span>
              <span className="text-muted-foreground text-xs">
                {format.dateTime(new Date(row.occurredAt), {
                  dateStyle: 'medium',
                  timeStyle: 'short'
                })}
              </span>
              {row.kind === GuideMovementKind.PURCHASE && row.paidQuantity !== null ? (
                <span className="text-muted-foreground text-xs">
                  {t('purchaseDetail', {
                    paid: row.paidQuantity,
                    gift: row.giftQuantity ?? 0,
                    cost: formatCents(format, row.costCentsDelta)
                  })}
                </span>
              ) : null}
              {row.note === null ? null : (
                <span className="text-muted-foreground text-xs break-words">{row.note}</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <span className="font-mono tabular-nums">
                {row.guidesDelta > 0 ? '+' : ''}
                {format.number(row.guidesDelta)}
              </span>
              {canManage && row.kind === GuideMovementKind.PURCHASE && !row.voided ? (
                <Button type="button" variant="outline" size="sm" onClick={() => onVoid(row.id)}>
                  {t('void')}
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      {movements.hasNextPage ? (
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={movements.isFetchingNextPage}
            busy={movements.isFetchingNextPage}
            onClick={() => void movements.fetchNextPage()}
          >
            {t('more')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
