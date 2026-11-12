'use client'

import { useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import { ApiError, type OrderShipmentView } from '@platform/api-client'
import { ClientErrorCodes } from '@platform/core/errors'

import { useRequestPickup } from '../../lib/shipping/use-shipping-screens'
import { toast } from '../../lib/toast'
import { useErrorText } from '../../lib/use-error-text'
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

// "Request pickup" for the one guide of an order that waits for it. A request after the cutoff of the day asks again, saying that the
// pickup would be for the next day; the carrier's refusals are read from the answer, never decided here.
export function OrderPickupDialog({
  shipment,
  onClose
}: {
  shipment: OrderShipmentView
  onClose: () => void
}): ReactElement {
  const t = useTranslations('orders.detail.shipping.pickup')
  const errorText = useErrorText()
  const { storeId } = useStore()
  const request = useRequestPickup(storeId)
  const [afterCutoff, setAfterCutoff] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  const send = (): void => {
    setRefusal(null)
    request.mutate(
      {
        connectionId: shipment.connectionId,
        shipmentIds: [shipment.id],
        ...(afterCutoff ? { confirmAfterCutoff: true } : {})
      },
      {
        onSuccess: () => {
          toast.success(t('done'))
          onClose()
        },
        onError: error => {
          if (error instanceof ApiError && error.is(ClientErrorCodes.PICKUP_CUTOFF_PASSED)) {
            setAfterCutoff(true)
            return
          }
          setRefusal(errorText(error))
        }
      }
    )
  }
  return (
    <Dialog open onOpenChange={next => (next || request.isPending ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>
            {t('description', { guide: shipment.guideNumber ?? shipment.id })}
          </DialogDescription>
        </DialogHeader>
        {afterCutoff ? (
          <p role="alert" className="text-sm font-medium text-amber-700 dark:text-amber-300">
            {t('cutoffPassed')}
          </p>
        ) : null}
        {refusal === null ? null : (
          <p role="alert" className="text-destructive text-sm">
            {refusal}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={request.isPending} onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            type="button"
            busy={request.isPending}
            disabled={request.isPending}
            onClick={send}
          >
            {afterCutoff ? t('confirmAnyway') : t('confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
