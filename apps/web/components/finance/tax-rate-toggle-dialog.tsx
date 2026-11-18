'use client'

import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '../ui/alert-dialog'

// The question before a tax rate is turned off or on: a rate that is off can no longer be chosen, so a stray click
// must not change it. Nothing runs until the person presses the button; Escape and Cancel leave the rate as it was.
export function TaxRateToggleDialog({
  open,
  onOpenChange,
  name,
  turningOn,
  busy,
  onConfirm
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  name: string
  // True when the rate is off now and the person is turning it on
  turningOn: boolean
  busy: boolean
  onConfirm: () => void
}): ReactElement {
  const t = useTranslations('finance.taxes.toggle')
  const kind = turningOn ? 'on' : 'off'
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid="finance-tax-rate-toggle-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{t(`${kind}.title`, { name })}</AlertDialogTitle>
          <AlertDialogDescription>{t(`${kind}.description`)}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{t('cancel')}</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            onClick={event => {
              // The dialog stays open until the work ends: the caller closes it
              event.preventDefault()
              onConfirm()
            }}
          >
            {t(`${kind}.confirm`)}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
