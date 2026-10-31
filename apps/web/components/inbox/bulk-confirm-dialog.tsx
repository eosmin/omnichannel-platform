'use client'

import { useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import type { BulkOperation, BulkTarget } from '@platform/api-client'
import { BulkActions, BulkLimits } from '@platform/core/domain'

import { phraseMatches } from '../../lib/destructive-action'
import { BulkConfirmations, confirmationOf, targetCountOf } from '../../lib/inbox/bulk'
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
import { Input } from '../ui/input'
import { Label } from '../ui/label'

export interface BulkRequest {
  operation: BulkOperation
  target: BulkTarget
  // What was chosen, named for the preview: an agent, a tag, a status
  label: string
}

// What will change, said before it does: the action, how many conversations it reaches, and for an
// archive the phrase typed (TDD_09 §10). Nothing is sent until the agent confirms.
export function BulkConfirmDialog({
  request,
  isPending,
  onConfirm,
  onCancel
}: {
  request: BulkRequest | null
  isPending: boolean
  onConfirm: (request: BulkRequest) => void
  onCancel: () => void
}): ReactElement {
  return (
    <AlertDialog open={request !== null} onOpenChange={open => (open ? undefined : onCancel())}>
      <AlertDialogContent>
        {request === null ? null : (
          <ConfirmBody
            key={`${request.operation.action}-${request.label}`}
            request={request}
            isPending={isPending}
            onConfirm={onConfirm}
          />
        )}
      </AlertDialogContent>
    </AlertDialog>
  )
}

function ConfirmBody({
  request,
  isPending,
  onConfirm
}: {
  request: BulkRequest
  isPending: boolean
  onConfirm: (request: BulkRequest) => void
}): ReactElement {
  const t = useTranslations('inbox.bulk.confirm')
  const [typed, setTyped] = useState('')
  const { operation, target, label } = request
  const count = targetCountOf(target)
  const needsPhrase = confirmationOf(operation, count) === BulkConfirmations.TYPED
  const phrase = t('archivePhrase')
  const scope =
    count === null ? t('scopeFilter', { max: BulkLimits.MAX_ITEMS }) : t('scopeIds', { count })
  const isArchive = operation.action === BulkActions.ARCHIVE
  const canConfirm = !isPending && (!needsPhrase || phraseMatches(typed, phrase))

  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle>{t('title')}</AlertDialogTitle>
        <AlertDialogDescription>
          {t(`summary.${operation.action}`, { scope, target: label })}
        </AlertDialogDescription>
      </AlertDialogHeader>
      {needsPhrase ? (
        <div className="grid gap-2">
          <Label htmlFor="bulk-confirm-phrase">{t('typePhrase', { phrase })}</Label>
          <Input
            id="bulk-confirm-phrase"
            value={typed}
            autoComplete="off"
            onChange={event => setTyped(event.target.value)}
          />
        </div>
      ) : null}
      <AlertDialogFooter>
        <AlertDialogCancel disabled={isPending}>{t('cancel')}</AlertDialogCancel>
        {/* A plain button, not AlertDialogAction: the dialog stays open while the request runs */}
        <Button
          type="button"
          variant={isArchive ? 'destructive' : 'default'}
          disabled={!canConfirm}
          onClick={() => onConfirm(request)}
        >
          {t('confirm')}
        </Button>
      </AlertDialogFooter>
    </>
  )
}
