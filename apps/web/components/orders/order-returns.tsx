'use client'

import Link from 'next/link'
import { useFormatter, useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import {
  AppPaths,
  type CarrierConnectionView,
  type OrderDetailView,
  type ReturnView
} from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'

import { returnGuideConnections } from '../../lib/orders/order-guide-form'
import {
  asReturnReasonKey,
  canStartReturn,
  offeredReturnActions,
  type ReturnAction,
  ReturnActions
} from '../../lib/orders/order-returns-rules'
import { useOrderReturns, useReturnWrites } from '../../lib/orders/use-order-returns'
import { formatCents } from '../../lib/products/money'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'

import { ReturnGuideDialog } from './order-guide-dialogs'
import {
  CreateReturnDialog,
  ReturnActionDialog,
  type WarehouseOption
} from './order-return-dialogs'

type DialogAction = Exclude<ReturnAction, typeof ReturnActions.RETURN_GUIDE>

// The Returns panel of the order detail (TDD_17 §4.11): the returns of the order with their lines and state, the moves each one
// accepts (the api's table of transitions, with returns:manage), and the form of a new one. The guide of the way back is made by
// a dialog of its own, offered while a connection of the store (`connections`, read with shipping:view) can make one.
export function OrderReturns({
  order,
  outboundStatuses,
  warehouses,
  connections
}: {
  order: OrderDetailView
  outboundStatuses: readonly string[] | null
  warehouses: readonly WarehouseOption[]
  connections: readonly CarrierConnectionView[] | undefined
}): ReactElement | null {
  const t = useTranslations('orders.detail.returns')
  const tAll = useTranslations()
  const format = useFormatter()
  const { storeId, can } = useStore()
  const mayView = can(ClientPermissions.RETURNS_VIEW)
  const mayManage = can(ClientPermissions.RETURNS_MANAGE)
  const returns = useOrderReturns(storeId, order.id, mayView)
  const writes = useReturnWrites(storeId, order.id)
  const [creating, setCreating] = useState(false)
  const [guiding, setGuiding] = useState<string | null>(null)
  const [moving, setMoving] = useState<{ action: DialogAction; id: string } | null>(null)
  if (!mayView) return null

  const list = returns.data ?? []
  const target = moving === null ? undefined : list.find(entry => entry.id === moving.id)
  const startable =
    mayManage &&
    returns.data !== undefined &&
    canStartReturn({
      orderStatus: order.status,
      outboundStatuses,
      items: order.items,
      returns: list
    })

  return (
    <section aria-labelledby="order-returns-heading" className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h2 id="order-returns-heading" className="text-base font-semibold">
          {t('heading')}
        </h2>
        {startable ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              writes.create.reset()
              setCreating(true)
            }}
          >
            {t('new')}
          </Button>
        ) : null}
      </div>
      {returns.isPending ? (
        <p role="status" className="text-muted-foreground text-sm">
          {t('loading')}
        </p>
      ) : returns.isError ? (
        <p role="alert" className="text-sm">
          {t('failed')}
        </p>
      ) : list.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('empty')}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {list.map(entry => {
            const reason = asReturnReasonKey(entry.reason)
            const actions = offeredReturnActions({
              status: entry.status,
              returnShipmentId: entry.returnShipmentId,
              mayManage,
              canMakeReturnGuide: returnGuideConnections(connections ?? []).length > 0
            })
            return (
              <li key={entry.id} className="flex flex-col gap-1.5 rounded border p-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{t(`type.${entry.type}`)}</span>
                  <span className="rounded border px-1.5 py-0.5 text-xs font-medium">
                    {t(`status.${entry.status}`)}
                  </span>
                  <time dateTime={entry.createdAt} className="text-muted-foreground text-xs">
                    {format.dateTime(new Date(entry.createdAt), {
                      dateStyle: 'medium',
                      timeStyle: 'short'
                    })}
                  </time>
                </div>
                <p>
                  {reason === null ? entry.reason : tAll(`orders.return.reason.${reason}`)}
                  {entry.notes === null ? null : (
                    <span className="text-muted-foreground block break-words">{entry.notes}</span>
                  )}
                </p>
                <ul className="text-muted-foreground">
                  {entry.lines.map(line => (
                    <li key={line.id}>
                      {line.productName}
                      {line.variantName === null ? '' : ` - ${line.variantName}`} x {line.quantity}
                      {line.condition === null ? null : ` (${t(`condition.${line.condition}`)})`}
                    </li>
                  ))}
                </ul>
                {entry.refundAmountCents === null ? null : (
                  <p>{t('refunded', { amount: formatCents(format, entry.refundAmountCents) })}</p>
                )}
                {entry.returnShipmentId === null ? null : (
                  <p className="text-muted-foreground">{t('hasGuide')}</p>
                )}
                {entry.replacementOrderId === null ? null : (
                  <Link
                    className="self-start underline underline-offset-2"
                    href={AppPaths.store.order(storeId, entry.replacementOrderId)}
                  >
                    {t('replacement')}
                  </Link>
                )}
                {actions.length === 0 ? null : (
                  <div className="flex flex-wrap gap-2">
                    {actions.map(action => (
                      <Button
                        key={action}
                        type="button"
                        size="sm"
                        variant={
                          action === ReturnActions.REJECT || action === ReturnActions.CANCEL
                            ? 'outline'
                            : 'default'
                        }
                        onClick={() => {
                          if (action === ReturnActions.RETURN_GUIDE) {
                            writes.returnGuide.reset()
                            setGuiding(entry.id)
                            return
                          }
                          writes.approve.reset()
                          writes.reject.reset()
                          writes.cancel.reset()
                          writes.inTransit.reset()
                          writes.receive.reset()
                          writes.complete.reset()
                          setMoving({ action, id: entry.id })
                        }}
                      >
                        {t(`action.${action}.button`)}
                      </Button>
                    ))}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {creating ? (
        <CreateReturnDialog
          order={order}
          returns={list}
          writes={writes}
          onClose={() => setCreating(false)}
        />
      ) : null}
      {guiding !== null && list.some(entry => entry.id === guiding) ? (
        <ReturnGuideDialog
          returnView={list.find(entry => entry.id === guiding) as ReturnView}
          connections={connections ?? []}
          warehouses={warehouses}
          writes={writes}
          onClose={() => setGuiding(null)}
        />
      ) : null}
      {moving !== null && target !== undefined ? (
        <ReturnActionDialog
          action={moving.action}
          returnView={target}
          order={order}
          warehouses={warehouses}
          writes={writes}
          onClose={() => setMoving(null)}
        />
      ) : null}
    </section>
  )
}
