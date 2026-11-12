'use client'

import { useTranslations } from 'next-intl'
import { type ReactElement, useId, useState } from 'react'

import type { ShipmentRowView } from '@platform/api-client'
import { ShipmentLimits, ShipmentStatus } from '@platform/core/domain'

import {
  useCancelShipment,
  useMarkShipmentVoided,
  useSetShipmentStatus
} from '../../lib/shipping/use-shipping-screens'
import { useSubmitGuard } from '../../lib/submit-guard'
import { toast } from '../../lib/toast'
import { useErrorText } from '../../lib/use-error-text'
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
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import { Input } from '../ui/input'
import { Label } from '../ui/label'

export type ShipmentDialogKind = 'cancel' | 'markVoided' | 'settle'

interface DialogProps {
  storeId: string
  shipment: ShipmentRowView
  open: boolean
  onOpenChange: (open: boolean) => void
  // Void: the carrier cannot be asked, so only this store's record is voided
  isLocalOnly: boolean
}

// Cancelling and "mark as voided" ask first and say what they do. The server decides again.
export function ShipmentConfirmDialog({
  kind,
  ...props
}: DialogProps & { kind: 'cancel' | 'markVoided' }): ReactElement {
  const t = useTranslations('shipments.dialogs')
  const errorText = useErrorText()
  const guard = useSubmitGuard()
  const cancel = useCancelShipment(props.storeId)
  const markVoided = useMarkShipmentVoided(props.storeId)
  const [refusal, setRefusal] = useState<string | null>(null)
  const mutation = kind === 'cancel' ? cancel : markVoided
  const run = (): void => {
    if (!guard.enter()) return
    setRefusal(null)
    mutation.mutate(props.shipment.id, {
      onSuccess: () => {
        toast.success(t(`${kind}.done`))
        props.onOpenChange(false)
      },
      onError: error => setRefusal(errorText(error)),
      onSettled: guard.leave
    })
  }
  return (
    <AlertDialog
      open={props.open}
      onOpenChange={next => (next || !mutation.isPending ? props.onOpenChange(next) : undefined)}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t(`${kind}.title`)}</AlertDialogTitle>
          <AlertDialogDescription>
            {t(`${kind}.description`, { guide: props.shipment.guideNumber ?? '' })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {kind === 'cancel' && props.isLocalOnly ? (
          <p role="note" className="text-sm font-medium text-amber-700 dark:text-amber-300">
            {t('cancel.localOnly')}
          </p>
        ) : null}
        {refusal === null ? null : (
          <p role="alert" className="text-destructive text-sm">
            {refusal}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={mutation.isPending}>{t('keep')}</AlertDialogCancel>
          <Button
            variant="destructive"
            disabled={mutation.isPending}
            busy={mutation.isPending}
            onClick={run}
          >
            {t(`${kind}.confirm`)}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

// A guide whose outcome is unknown (`requires_review`) is settled by a person: the carrier has it (and says its number) or it
// does not (the guide failed and the order may be tried again)
export function ShipmentSettleDialog(props: DialogProps): ReactElement {
  const t = useTranslations('shipments.dialogs.settle')
  const errorText = useErrorText()
  const guard = useSubmitGuard()
  const setStatus = useSetShipmentStatus(props.storeId)
  const [found, setFound] = useState(true)
  const [guideNumber, setGuideNumber] = useState('')
  const [refusal, setRefusal] = useState<string | null>(null)
  const id = useId()
  const number = guideNumber.trim()
  const canSend = !found || number !== ''
  const submit = (): void => {
    if (!canSend || !guard.enter()) return
    setRefusal(null)
    setStatus.mutate(
      found
        ? { id: props.shipment.id, status: ShipmentStatus.LABEL_CREATED, guideNumber: number }
        : { id: props.shipment.id, status: ShipmentStatus.FAILED },
      {
        onSuccess: () => {
          toast.success(t(found ? 'doneFound' : 'doneFailed'))
          props.onOpenChange(false)
        },
        onError: error => setRefusal(errorText(error)),
        onSettled: guard.leave
      }
    )
  }
  return (
    <Dialog
      open={props.open}
      onOpenChange={next => (next || !setStatus.isPending ? props.onOpenChange(next) : undefined)}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <fieldset className="flex flex-col gap-2">
          <legend className="sr-only">{t('title')}</legend>
          <label className="flex items-start gap-2 text-sm pointer-coarse:min-h-10">
            <input
              type="radio"
              name={`${id}-outcome`}
              className="mt-1"
              checked={found}
              onChange={() => setFound(true)}
            />
            <span>{t('found')}</span>
          </label>
          <label className="flex items-start gap-2 text-sm pointer-coarse:min-h-10">
            <input
              type="radio"
              name={`${id}-outcome`}
              className="mt-1"
              checked={!found}
              onChange={() => setFound(false)}
            />
            <span>{t('notFound')}</span>
          </label>
        </fieldset>
        {found ? (
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-guide`}>{t('guideNumber')}</Label>
            <Input
              id={`${id}-guide`}
              value={guideNumber}
              maxLength={ShipmentLimits.GUIDE_NUMBER_MAX_LENGTH}
              onChange={event => setGuideNumber(event.target.value)}
            />
          </div>
        ) : null}
        {refusal === null ? null : (
          <p role="alert" className="text-destructive text-sm">
            {refusal}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="outline"
            disabled={setStatus.isPending}
            onClick={() => props.onOpenChange(false)}
          >
            {t('cancel')}
          </Button>
          <Button
            disabled={!canSend || setStatus.isPending}
            busy={setStatus.isPending}
            onClick={submit}
          >
            {t('save')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
