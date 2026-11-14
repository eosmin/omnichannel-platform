'use client'

import { CalendarClock, ExternalLink, Printer } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import type { OrderDetailView, OrderShipmentView } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'
import {
  type ShipmentFailureReason,
  ShipmentFailureReasons,
  ShipmentKind
} from '@platform/core/domain'

import {
  asShipmentStatus,
  GuideBlocks,
  guideBlockOf,
  offeredShipmentActions,
  type ShipmentAction,
  ShipmentActions
} from '../../lib/orders/order-shipping-rules'
import { type ShipmentWrites } from '../../lib/orders/use-order-guides'
import { formatCents } from '../../lib/products/money'
import { toast } from '../../lib/toast'
import { MutationError } from '../customers/mutation-error'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'

import { OrderPickupDialog } from './order-pickup-dialog'

const RETURN_KIND: string = ShipmentKind.RETURN
// A reason of the closed list reads in the language of the person; anything else is the one line the carrier said
const asFailureReason = (value: string): ShipmentFailureReason | null =>
  Object.values(ShipmentFailureReasons).find(known => known === value) ?? null

// The tracking page is the carrier's: it opens only when it is a web address (a value of a carrier is not trusted to be a link)
function safeHref(url: string | null): string | null {
  if (url === null) return null
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : null
  } catch {
    return null
  }
}

// The label opens in a tab that is opened by the click itself (a tab opened after the answer arrives is a popup, which the browser
// may block) and is pointed at the link when it comes: the link is good for minutes and is kept nowhere. The new tab has no opener.
function printLabel(ask: (onLink: (url: string) => void, onFail: () => void) => void): void {
  const tab = window.open('about:blank', '_blank')
  if (tab !== null) tab.opener = null
  ask(
    url => {
      if (tab === null) window.open(url, '_blank', 'noopener,noreferrer')
      else tab.location.href = url
    },
    () => tab?.close()
  )
}

function ConfirmMove({
  action,
  shipment,
  carrierCanCancel,
  writes,
  onClose
}: {
  action: typeof ShipmentActions.CANCEL | typeof ShipmentActions.MARK_VOIDED
  shipment: OrderShipmentView
  // False for a carrier that cannot be asked: the cancel only parks the guide until it is voided by hand
  carrierCanCancel: boolean | null
  writes: ShipmentWrites
  onClose: () => void
}): ReactElement {
  const t = useTranslations('orders.detail.shipping.move')
  const tAll = useTranslations()
  const mutation = action === ShipmentActions.CANCEL ? writes.cancel : writes.markVoided
  return (
    <Dialog open onOpenChange={next => (next || mutation.isPending ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t(`${action}.title`)}</DialogTitle>
          <DialogDescription>
            {t(
              action === ShipmentActions.CANCEL && carrierCanCancel === false
                ? 'cancel.descriptionManual'
                : `${action}.description`,
              { guide: shipment.guideNumber ?? shipment.id }
            )}
          </DialogDescription>
        </DialogHeader>
        <MutationError error={mutation.error} />
        <DialogFooter>
          <Button type="button" variant="outline" disabled={mutation.isPending} onClick={onClose}>
            {tAll('common.cancel')}
          </Button>
          <Button
            type="button"
            variant="destructive"
            busy={mutation.isPending}
            disabled={mutation.isPending}
            onClick={() =>
              mutation.mutate(shipment.id, {
                onSuccess: () => {
                  toast.success(t(`${action}.done`))
                  onClose()
                }
              })
            }
          >
            {t(`${action}.confirm`)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ShipmentRow({
  shipment,
  carrierCanCancel,
  carrierTakesPickups,
  writes,
  onMove,
  onRequestPickup
}: {
  shipment: OrderShipmentView
  carrierCanCancel: boolean | null
  carrierTakesPickups: boolean | null
  writes: ShipmentWrites
  onMove: (action: typeof ShipmentActions.CANCEL | typeof ShipmentActions.MARK_VOIDED) => void
  onRequestPickup: () => void
}): ReactElement {
  const t = useTranslations('orders.detail.shipping')
  const format = useFormatter()
  const { can } = useStore()
  const status = asShipmentStatus(shipment.status)
  const href = safeHref(shipment.trackingUrl)
  const actions = offeredShipmentActions({
    status: shipment.status,
    kind: shipment.kind,
    hasLabel: shipment.hasLabel,
    refundStatus: shipment.refundStatus,
    mayManage: can(ClientPermissions.SHIPPING_MANAGE),
    pickupId: shipment.pickupId,
    mayRequestPickup: can(ClientPermissions.SHIPPING_MANAGE_PICKUPS),
    carrierTakesPickups,
    carrierCanCancel
  })
  const failure = shipment.lastError
  const reason = failure === null ? null : asFailureReason(failure)
  const run = (action: ShipmentAction): void => {
    if (action === ShipmentActions.PRINT_LABEL) {
      printLabel((onLink, onFail) =>
        writes.label.mutate(shipment.id, {
          onSuccess: link => onLink(link.url),
          onError: onFail
        })
      )
      return
    }
    if (action === ShipmentActions.REQUEST_PICKUP) {
      onRequestPickup()
      return
    }
    writes.cancel.reset()
    writes.markVoided.reset()
    onMove(action)
  }
  return (
    <li className="flex flex-col gap-1 rounded border p-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{shipment.connectionName}</span>
        <span className="rounded border px-1.5 py-0.5 text-xs font-medium">
          {status === null ? t('unknownStatus') : t(`status.${status}`)}
        </span>
        {shipment.kind === RETURN_KIND ? (
          <span className="text-muted-foreground text-xs">{t('returnLeg')}</span>
        ) : null}
        <time dateTime={shipment.createdAt} className="text-muted-foreground text-xs">
          {format.dateTime(new Date(shipment.createdAt), {
            dateStyle: 'medium',
            timeStyle: 'short'
          })}
        </time>
      </div>
      {shipment.guideNumber === null ? null : (
        <p>
          {t('guide')} <span className="font-medium break-all">{shipment.guideNumber}</span>
        </p>
      )}
      {shipment.codAmountCents === null || shipment.codAmountCents === 0 ? null : (
        <p>{t('collects', { amount: formatCents(format, shipment.codAmountCents) })}</p>
      )}
      {failure === null ? null : (
        <p role="status" className="text-amber-700 dark:text-amber-300">
          {reason === null ? failure : t(`failure.${reason}`)}
        </p>
      )}
      {href === null ? null : (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 self-start underline underline-offset-2"
        >
          {t('track')}
          <ExternalLink aria-hidden className="size-3.5" />
          <span className="sr-only">{t('opensInNewTab')}</span>
        </a>
      )}
      {actions.length === 0 ? null : (
        <div className="flex flex-wrap gap-2">
          {actions.map(action => (
            <Button
              key={action}
              type="button"
              size="sm"
              variant={action === ShipmentActions.PRINT_LABEL ? 'default' : 'outline'}
              disabled={action === ShipmentActions.PRINT_LABEL && writes.label.isPending}
              onClick={() => run(action)}
            >
              {action === ShipmentActions.PRINT_LABEL ? <Printer aria-hidden /> : null}
              {action === ShipmentActions.REQUEST_PICKUP ? <CalendarClock aria-hidden /> : null}
              {t(`action.${action}`)}
            </Button>
          ))}
        </div>
      )}
    </li>
  )
}

// The Shipping panel of the order detail (TDD_17 §4.5, §4.8): the guides of the order, their state and tracking page, the label and
// the cancellation. Controls show only for who holds shipping:manage; what a connection can do comes from its capabilities
// (`carrierCanCancel`, null while the connections are not known). Making the guide is a dialog the page opens (`onCreateGuide`).
export function OrderShipping({
  order,
  shipments,
  isPending,
  isError,
  writes,
  carrierCanCancel,
  carrierTakesPickups,
  onCreateGuide
}: {
  order: OrderDetailView
  shipments: readonly OrderShipmentView[]
  isPending: boolean
  isError: boolean
  writes: ShipmentWrites
  carrierCanCancel: (connectionId: string) => boolean | null
  // Whether a connection's carrier is asked for pickups from here; null while the connections are not known
  carrierTakesPickups: (connectionId: string) => boolean | null
  onCreateGuide?: () => void
}): ReactElement | null {
  const t = useTranslations('orders.detail.shipping')
  const { can } = useStore()
  const [moving, setMoving] = useState<{
    action: typeof ShipmentActions.CANCEL | typeof ShipmentActions.MARK_VOIDED
    id: string
  } | null>(null)
  const [pickupFor, setPickupFor] = useState<string | null>(null)
  if (!can(ClientPermissions.SHIPPING_VIEW)) return null
  const target = moving === null ? undefined : shipments.find(entry => entry.id === moving.id)
  const pickupTarget =
    pickupFor === null ? undefined : shipments.find(entry => entry.id === pickupFor)
  const block = isPending || isError ? null : guideBlockOf({ order, shipments })
  const mayMake =
    can(ClientPermissions.SHIPPING_MANAGE) && onCreateGuide !== undefined && block === null
  return (
    <section aria-labelledby="order-shipping-heading" className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h2 id="order-shipping-heading" className="text-base font-semibold">
          {t('heading')}
        </h2>
        {mayMake ? (
          <Button type="button" size="sm" variant="outline" onClick={onCreateGuide}>
            {t('makeGuide')}
          </Button>
        ) : null}
      </div>
      {isPending ? (
        <p role="status" className="text-muted-foreground text-sm">
          {t('loading')}
        </p>
      ) : isError ? (
        <p role="alert" className="text-sm">
          {t('failed')}
        </p>
      ) : shipments.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('empty')}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {shipments.map(shipment => (
            <ShipmentRow
              key={shipment.id}
              shipment={shipment}
              carrierCanCancel={carrierCanCancel(shipment.connectionId)}
              carrierTakesPickups={carrierTakesPickups(shipment.connectionId)}
              writes={writes}
              onMove={action => setMoving({ action, id: shipment.id })}
              onRequestPickup={() => setPickupFor(shipment.id)}
            />
          ))}
        </ul>
      )}
      {block === null || block === GuideBlocks.HAS_GUIDE ? null : (
        <p className="text-muted-foreground text-xs">{t(`blocked.${block}`)}</p>
      )}
      <MutationError error={writes.label.error} />
      {pickupTarget === undefined ? null : (
        <OrderPickupDialog shipment={pickupTarget} onClose={() => setPickupFor(null)} />
      )}
      {moving !== null && target !== undefined ? (
        <ConfirmMove
          action={moving.action}
          shipment={target}
          carrierCanCancel={carrierCanCancel(target.connectionId)}
          writes={writes}
          onClose={() => setMoving(null)}
        />
      ) : null}
    </section>
  )
}
