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

import type { DestructiveActionRequest } from './destructive-action'

// The confirmation of a destructive action, downloaded the first time one is asked (`DestructiveActionProvider`
// holds the state and the rules; this only draws them)
export default function DestructiveDialog({
  open,
  onOpenChange,
  request,
  requiresPhrase,
  destructive,
  busy,
  canConfirm,
  typed,
  onTyped,
  phraseId,
  onConfirm
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  request: DestructiveActionRequest | undefined
  requiresPhrase: boolean
  destructive: boolean
  busy: boolean
  canConfirm: boolean
  typed: string
  onTyped: (typed: string) => void
  phraseId: string
  onConfirm: () => void
}): ReactElement {
  const t = useTranslations()
  const phrase = request?.phrase
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent aria-busy={busy}>
        <AlertDialogHeader>
          <AlertDialogTitle>{request?.title}</AlertDialogTitle>
          <AlertDialogDescription>{request?.description}</AlertDialogDescription>
        </AlertDialogHeader>
        {requiresPhrase && phrase !== undefined ? (
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
            className={destructive ? buttonVariants({ variant: 'destructive' }) : undefined}
            onClick={event => {
              // Radix closes the dialog on click; it closes here once the work is done
              event.preventDefault()
              onConfirm()
            }}
          >
            {request?.confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
