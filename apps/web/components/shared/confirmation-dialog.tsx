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
import { buttonVariants } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'

import type { DialogRequest } from './destructive-action'

// The dialog of DestructiveActionProvider, which loads it when the first request comes
export function ConfirmationDialog({
  open,
  busy,
  dialog,
  typed,
  phraseId,
  canConfirm,
  onTyped,
  onConfirm,
  onOpenChange
}: {
  open: boolean
  busy: boolean
  dialog: DialogRequest
  typed: string
  phraseId: string
  canConfirm: boolean
  onTyped: (value: string) => void
  onConfirm: () => void
  onOpenChange: (open: boolean) => void
}): ReactElement {
  const t = useTranslations()
  const phrase = dialog.request.phrase
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent aria-busy={busy}>
        <AlertDialogHeader>
          <AlertDialogTitle>{dialog.request.title}</AlertDialogTitle>
          <AlertDialogDescription>{dialog.request.description}</AlertDialogDescription>
        </AlertDialogHeader>
        {dialog.requiresPhrase && phrase !== undefined ? (
          <div className="grid gap-2">
            <Label htmlFor={phraseId}>{t('confirm.phraseLabel')}</Label>
            <Input
              id={phraseId}
              autoComplete="off"
              value={typed}
              placeholder={phrase}
              onChange={event => onTyped(event.target.value)}
            />
            <p className="text-muted-foreground text-sm">{t('confirm.typePhrase', { phrase })}</p>
          </div>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            disabled={!canConfirm || busy}
            className={dialog.destructive ? buttonVariants({ variant: 'destructive' }) : undefined}
            onClick={event => {
              // Radix closes the dialog on click; it closes once the work is done
              event.preventDefault()
              onConfirm()
            }}
          >
            {dialog.request.confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
