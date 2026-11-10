'use client'

import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

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

import { ProductError } from './product-error'

// "Delete this?", said before it happens. The dialog stays open while the request runs, and shows the reason
// when the api refuses (a product with history, for one) instead of closing on a failure.
export function ConfirmRemove({
  isOpen,
  title,
  body,
  confirmLabel,
  isPending,
  error,
  canConfirm = true,
  onConfirm,
  onCancel
}: {
  isOpen: boolean
  title: string
  body: string
  confirmLabel: string
  isPending: boolean
  error: Error | null
  // False when the person may not do what the dialog offers: it then only says why
  canConfirm?: boolean
  onConfirm: () => void
  onCancel: () => void
}): ReactElement {
  const tAll = useTranslations()
  return (
    <AlertDialog open={isOpen} onOpenChange={open => (open ? undefined : onCancel())}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{body}</AlertDialogDescription>
        </AlertDialogHeader>
        <ProductError error={error} />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>{tAll('common.cancel')}</AlertDialogCancel>
          {canConfirm ? (
            <Button
              type="button"
              variant="destructive"
              disabled={isPending}
              busy={isPending}
              onClick={onConfirm}
            >
              {confirmLabel}
            </Button>
          ) : null}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
