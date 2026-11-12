'use client'

import Link from 'next/link'
import { useFormatter, useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import { AppPaths, type ReturnView } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'
import { OrderReturnStatus, OrderReturnType } from '@platform/core/domain'

import { useWarehousesOfStore } from '../../lib/inventory/use-inventory'
import { returnGuideConnections } from '../../lib/orders/order-guide-form'
import {
  asReturnReasonKey,
  offeredReturnActions,
  type ReturnAction,
  ReturnActions
} from '../../lib/orders/order-returns-rules'
import { useOrder } from '../../lib/orders/use-order'
import { useGuideConnections } from '../../lib/orders/use-order-guides'
import { useReturnWrites } from '../../lib/orders/use-order-returns'
import { formatCents } from '../../lib/products/money'
import { ReturnGuideDialog } from '../orders/order-guide-dialogs'
import { ReturnActionDialog } from '../orders/order-return-dialogs'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'

import { ReturnStatusText } from './return-badges'

type DialogAction = Exclude<ReturnAction, typeof ReturnActions.RETURN_GUIDE>

// The states in which an exchange's replacement may already be alive: cancelling or rejecting then leaves it (TDD_17 §4.11)
const REPLACEMENT_ALIVE: readonly OrderReturnStatus[] = [
  OrderReturnStatus.APPROVED,
  OrderReturnStatus.IN_TRANSIT
]

// One return with what it holds, and the moves its state accepts with returns:manage. The dialogs, the writes and the words are the
// ones of the Returns panel of the order detail (one place decides each rule); the order is read here because those dialogs need it.
export function ReturnDetail({ entry }: { entry: ReturnView }): ReactElement {
  const t = useTranslations('returns.detail')
  const tPanel = useTranslations('orders.detail.returns')
  const tAll = useTranslations()
  const format = useFormatter()
  const { storeId, can } = useStore()
  const mayManage = can(ClientPermissions.RETURNS_MANAGE)
  const order = useOrder(storeId, entry.orderId, mayManage && can(ClientPermissions.ORDERS_VIEW))
  const warehouses = useWarehousesOfStore(storeId, can(ClientPermissions.INVENTORY_VIEW))
  const connections = useGuideConnections(
    storeId,
    mayManage && can(ClientPermissions.SHIPPING_VIEW)
  )
  const writes = useReturnWrites(storeId, entry.orderId)
  const [guiding, setGuiding] = useState(false)
  const [moving, setMoving] = useState<DialogAction | null>(null)

  const reason = asReturnReasonKey(entry.reason)
  const actions = offeredReturnActions({
    status: entry.status,
    returnShipmentId: entry.returnShipmentId,
    mayManage,
    // The way back is a guide that may cost money: it needs the shipping permission as well (the api checks it too)
    canMakeReturnGuide:
      can(ClientPermissions.SHIPPING_MANAGE) &&
      returnGuideConnections(connections.data ?? []).length > 0
  })
  const moment = (iso: string): string =>
    format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' })
  const warnsReplacement =
    entry.type === OrderReturnType.EXCHANGE &&
    entry.replacementOrderId !== null &&
    REPLACEMENT_ALIVE.includes(entry.status)

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">{t('heading', { number: entry.orderNumber })}</h1>
          <ReturnStatusText status={entry.status} />
          <span className="rounded border px-1.5 py-0.5 text-xs font-medium">
            {tPanel(`type.${entry.type}`)}
          </span>
        </div>
        <p className="text-muted-foreground text-sm">
          {t('made', { date: moment(entry.createdAt) })}
        </p>
        {entry.receivedAt === null ? null : (
          <p className="text-muted-foreground text-sm">
            {t('receivedOn', { date: moment(entry.receivedAt) })}
          </p>
        )}
        <Link
          href={AppPaths.store.order(storeId, entry.orderId)}
          className="self-start text-sm underline underline-offset-2"
        >
          {t('openOrder', { number: entry.orderNumber })}
        </Link>
      </header>

      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
        <dt className="font-medium">{t('reasonLabel')}</dt>
        <dd>{reason === null ? entry.reason : tAll(`orders.return.reason.${reason}`)}</dd>
        <dt className="font-medium">{t('payerLabel')}</dt>
        <dd>{tPanel(`payer.${entry.shippingPayer}`)}</dd>
        {entry.notes === null ? null : (
          <>
            <dt className="font-medium">{t('notesLabel')}</dt>
            <dd className="break-words whitespace-pre-wrap">{entry.notes}</dd>
          </>
        )}
      </dl>

      <section aria-labelledby="return-lines-heading" className="flex flex-col gap-2">
        <h2 id="return-lines-heading" className="text-base font-semibold">
          {t('linesHeading')}
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b">
                <th scope="col" className="py-1 pr-3 font-medium">
                  {t('lineColumns.product')}
                </th>
                <th scope="col" className="py-1 pr-3 text-right font-medium">
                  {t('lineColumns.quantity')}
                </th>
                <th scope="col" className="py-1 font-medium">
                  {t('lineColumns.condition')}
                </th>
              </tr>
            </thead>
            <tbody>
              {entry.lines.map(line => (
                <tr key={line.id} className="border-b">
                  <td className="py-2 pr-3">
                    {line.productName}
                    {line.variantName === null ? '' : ` - ${line.variantName}`}
                  </td>
                  <td className="py-2 pr-3 text-right">{line.quantity}</td>
                  <td className="py-2">
                    {line.condition === null ? (
                      <span className="text-muted-foreground">{t('notReceived')}</span>
                    ) : (
                      tPanel(`condition.${line.condition}`)
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-sm">
          {entry.refundAmountCents === null
            ? t('noRefund')
            : t('refunded', { amount: formatCents(format, entry.refundAmountCents) })}
        </p>
      </section>

      <section aria-labelledby="return-way-back-heading" className="flex flex-col gap-1">
        <h2 id="return-way-back-heading" className="text-base font-semibold">
          {t('guideHeading')}
        </h2>
        <p className="text-sm">{entry.returnShipmentId === null ? t('noGuide') : t('hasGuide')}</p>
      </section>

      {entry.replacementOrderId === null ? null : (
        <section aria-labelledby="return-replacement-heading" className="flex flex-col gap-1">
          <h2 id="return-replacement-heading" className="text-base font-semibold">
            {t('replacementHeading')}
          </h2>
          <Link
            href={AppPaths.store.order(storeId, entry.replacementOrderId)}
            className="self-start text-sm underline underline-offset-2"
          >
            {t('replacement')}
          </Link>
        </section>
      )}

      {mayManage ? (
        <section aria-labelledby="return-actions-heading" className="flex flex-col gap-2">
          <h2 id="return-actions-heading" className="text-base font-semibold">
            {t('actionsHeading')}
          </h2>
          {warnsReplacement ? (
            <p role="note" className="text-sm">
              {t('exchangeNotice')}
            </p>
          ) : null}
          {actions.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t('noActions')}</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {actions.map(action => (
                <Button
                  key={action}
                  type="button"
                  variant={
                    action === ReturnActions.REJECT || action === ReturnActions.CANCEL
                      ? 'outline'
                      : 'default'
                  }
                  disabled={action !== ReturnActions.RETURN_GUIDE && order.data === undefined}
                  onClick={() => {
                    if (action === ReturnActions.RETURN_GUIDE) {
                      writes.returnGuide.reset()
                      setGuiding(true)
                      return
                    }
                    writes.approve.reset()
                    writes.reject.reset()
                    writes.cancel.reset()
                    writes.inTransit.reset()
                    writes.receive.reset()
                    writes.complete.reset()
                    setMoving(action)
                  }}
                >
                  {tPanel(`action.${action}.button`)}
                </Button>
              ))}
            </div>
          )}
          {actions.length > 0 && order.data === undefined ? (
            <p role="status" className="text-muted-foreground text-sm">
              {can(ClientPermissions.ORDERS_VIEW) ? t('needsOrder') : t('needsOrderPermission')}
            </p>
          ) : null}
        </section>
      ) : null}

      {guiding && connections.data !== undefined ? (
        <ReturnGuideDialog
          returnView={entry}
          connections={connections.data}
          warehouses={warehouses.data ?? []}
          writes={writes}
          onClose={() => setGuiding(false)}
        />
      ) : null}
      {moving !== null && order.data !== undefined ? (
        <ReturnActionDialog
          action={moving}
          returnView={entry}
          order={order.data}
          warehouses={warehouses.data ?? []}
          writes={writes}
          onClose={() => setMoving(null)}
        />
      ) : null}
    </div>
  )
}
