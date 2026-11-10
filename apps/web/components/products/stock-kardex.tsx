'use client'

import { useFormatter, useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import type { KardexParams } from '@platform/api-client'

import { isAdjustmentReason, isMovementType, signedQuantity } from '../../lib/inventory/stock-form'
import { useKardex } from '../../lib/inventory/use-inventory'
import { formatCents } from '../../lib/products/money'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'

// The kardex of one item in one warehouse: each movement with what was on hand after it, newest first, a page at a
// time. The cost of the units is a column only when the api sent it (who holds products:view_cost).
export function StockKardex({
  item
}: {
  item: Omit<KardexParams, 'cursor' | 'limit'>
}): ReactElement {
  const t = useTranslations('products.stock')
  const tAll = useTranslations()
  const format = useFormatter()
  const { storeId } = useStore()
  const kardex = useKardex(storeId, item)
  const rows = kardex.data?.pages.flatMap(page => page.data) ?? []
  const hasCost = rows.some(row => row.unitCostCents !== undefined)

  if (kardex.isError && rows.length === 0) {
    return (
      <div role="alert" className="flex flex-col items-start gap-2 text-sm">
        <p>{t('kardex.failed')}</p>
        <Button variant="outline" size="sm" onClick={() => void kardex.refetch()}>
          {tAll('common.tryAgain')}
        </Button>
      </div>
    )
  }
  if (kardex.isPending) {
    return (
      <p role="status" className="text-muted-foreground text-sm">
        {tAll('common.loading')}
      </p>
    )
  }
  if (rows.length === 0) return <p className="text-muted-foreground text-sm">{t('kardex.empty')}</p>

  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b">
              <th className="py-2 pr-3 font-medium">{t('kardex.columns.date')}</th>
              <th className="py-2 pr-3 font-medium">{t('kardex.columns.type')}</th>
              <th className="py-2 pr-3 text-right font-medium">{t('kardex.columns.quantity')}</th>
              <th className="py-2 pr-3 text-right font-medium">{t('kardex.columns.onHand')}</th>
              <th className="py-2 pr-3 text-right font-medium">{t('kardex.columns.reserved')}</th>
              {hasCost ? (
                <th className="py-2 pr-3 text-right font-medium">{t('kardex.columns.cost')}</th>
              ) : null}
              <th className="py-2 font-medium">{t('kardex.columns.reason')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => {
              const signed = signedQuantity(row.type, row.quantity)
              return (
                <tr key={row.id} className="border-b align-top">
                  <td className="py-2 pr-3 whitespace-nowrap">
                    {format.dateTime(new Date(row.createdAt), {
                      dateStyle: 'short',
                      timeStyle: 'short'
                    })}
                  </td>
                  <td className="py-2 pr-3">
                    {isMovementType(row.type) ? t(`types.${row.type}`) : row.type}
                  </td>
                  <td className="py-2 pr-3 text-right whitespace-nowrap tabular-nums">
                    {/* A reservation moves no stock: its quantity is shown without a sign */}
                    {signed === 0 ? row.quantity : format.number(signed, { signDisplay: 'always' })}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">{row.onHandAfter}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{row.reservedAfter}</td>
                  {hasCost ? (
                    <td className="py-2 pr-3 text-right whitespace-nowrap tabular-nums">
                      {row.unitCostCents === undefined || row.unitCostCents === null
                        ? ''
                        : formatCents(format, row.unitCostCents)}
                    </td>
                  ) : null}
                  <td className="py-2">
                    {row.reason === null
                      ? ''
                      : isAdjustmentReason(row.reason)
                        ? t(`reasons.${row.reason}`)
                        : row.reason}
                    {row.note === null ? null : (
                      <span className="text-muted-foreground block">{row.note}</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {kardex.isError ? (
        <div role="alert" className="flex flex-col items-start gap-2 text-sm">
          <p>{t('kardex.failed')}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void (kardex.hasNextPage ? kardex.fetchNextPage() : kardex.refetch())}
          >
            {tAll('common.tryAgain')}
          </Button>
        </div>
      ) : null}
      {kardex.hasNextPage ? (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          disabled={kardex.isFetchingNextPage}
          busy={kardex.isFetchingNextPage}
          onClick={() => void kardex.fetchNextPage()}
        >
          {t('kardex.loadMore')}
        </Button>
      ) : null}
    </div>
  )
}
