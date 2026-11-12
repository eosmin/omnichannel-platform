'use client'

import { useRouter } from 'next/navigation'
import { useFormatter, useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useState } from 'react'

import { AppPaths, type RemittanceDetailView } from '@platform/api-client'
import { type ConfirmRemittanceBody, RemittanceLimits } from '@platform/core/domain'

import { formatCents } from '../../lib/products/money'
import { isSettling, mayConfirm, unsettledCount } from '../../lib/remittances/remittance-rules'
import {
  useConfirmRemittance,
  useDiscardRemittance,
  useVoidRemittance
} from '../../lib/remittances/use-remittances'
import { toast } from '../../lib/toast'
import { useErrorText } from '../../lib/use-error-text'
import { useStore } from '../providers/store-context'
import { useDestructiveAction } from '../shared/destructive-action'
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
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Textarea } from '../ui/textarea'

// What the agent adds when confirming: the settlement number, the day it arrived and a note, each only if typed
function confirmBody(reference: string, receivedOn: string, note: string): ConfirmRemittanceBody {
  const body: ConfirmRemittanceBody = {}
  if (reference.trim() !== '') body.reference = reference.trim()
  if (receivedOn !== '') body.receivedOn = receivedOn
  if (note.trim() !== '') body.note = note.trim()
  return body
}

// Confirming moves money records: every shipment that matched is marked as remitted. It asks twice, with the totals in the
// second question, and it says how many lines settle nothing so that they are read first.
export function ConfirmPanel({ remittance }: { remittance: RemittanceDetailView }): ReactElement {
  const t = useTranslations('remittances.confirm')
  const format = useFormatter()
  const errorText = useErrorText()
  const { storeId } = useStore()
  const confirm = useConfirmRemittance(storeId, remittance.id)
  const [reference, setReference] = useState(remittance.reference ?? '')
  const [receivedOn, setReceivedOn] = useState(remittance.receivedOn ?? '')
  const [note, setNote] = useState(remittance.note ?? '')
  const [asking, setAsking] = useState(false)
  const settles = remittance.lines.filter(isSettling).length
  const unsettled = unsettledCount(remittance)
  const ready = mayConfirm(remittance)

  const ask = (event: FormEvent): void => {
    event.preventDefault()
    if (ready) setAsking(true)
  }

  return (
    <section
      aria-labelledby="remittance-confirm-title"
      className="flex flex-col gap-3 rounded-md border p-4"
    >
      <h2 id="remittance-confirm-title" className="text-lg font-semibold">
        {t('title')}
      </h2>
      <form onSubmit={ask} className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="remittance-reference">{t('reference')}</Label>
            <Input
              id="remittance-reference"
              maxLength={RemittanceLimits.REFERENCE_MAX_LENGTH}
              value={reference}
              onChange={event => setReference(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="remittance-received-on">{t('receivedOn')}</Label>
            <Input
              id="remittance-received-on"
              type="date"
              value={receivedOn}
              onChange={event => setReceivedOn(event.target.value)}
            />
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="remittance-note">{t('note')}</Label>
          <Textarea
            id="remittance-note"
            rows={2}
            maxLength={RemittanceLimits.NOTE_MAX_LENGTH}
            value={note}
            onChange={event => setNote(event.target.value)}
          />
        </div>
        {unsettled > 0 ? (
          <p role="status" className="text-sm">
            {t('unsettled', { count: unsettled })}
          </p>
        ) : null}
        {ready ? null : <p className="text-muted-foreground text-sm">{t('nothingToSettle')}</p>}
        {confirm.isError ? (
          <p role="alert" className="text-destructive text-sm">
            {errorText(confirm.error)}
          </p>
        ) : null}
        <Button type="submit" className="self-start" disabled={!ready || confirm.isPending}>
          {t('action')}
        </Button>
      </form>
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogContent aria-busy={confirm.isPending}>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('dialog.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('dialog.description', {
                count: settles,
                amount: formatCents(format, remittance.totals.reportedCents),
                carrier: remittance.connectionName
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={confirm.isPending}>{t('dialog.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={confirm.isPending}
              onClick={event => {
                // The dialog closes once the work is done, not on the press
                event.preventDefault()
                confirm.mutate(confirmBody(reference, receivedOn, note), {
                  onSuccess: () => {
                    setAsking(false)
                    toast.success(t('done'))
                  },
                  onError: () => setAsking(false)
                })
              }}
            >
              {t('dialog.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}

// Voiding a confirmed remittance puts its shipments back to waiting for a remittance: a HIGH action (TDD_09 §11.1) that
// asks in a dialog, with the reason typed before it
export function VoidPanel({ remittance }: { remittance: RemittanceDetailView }): ReactElement {
  const t = useTranslations('remittances.void')
  const errorText = useErrorText()
  const run = useDestructiveAction()
  const { storeId } = useStore()
  const voiding = useVoidRemittance(storeId, remittance.id)
  const [reason, setReason] = useState('')
  const label = remittance.reference ?? remittance.connectionName

  const ask = (): void =>
    run('VOID_CONFIRMED_REMITTANCE', {
      title: t('dialog.title', { name: label }),
      description: t('dialog.description'),
      confirmLabel: t('dialog.confirm'),
      onConfirm: async () => {
        voiding.reset()
        try {
          await voiding.mutateAsync(reason.trim() === '' ? null : reason.trim())
          toast.success(t('done'))
        } catch {
          // The reason is shown on the page (`voiding.error`)
        }
      }
    })

  return (
    <section
      aria-labelledby="remittance-void-title"
      className="flex flex-col gap-3 rounded-md border p-4"
    >
      <h2 id="remittance-void-title" className="text-lg font-semibold">
        {t('title')}
      </h2>
      <p className="text-muted-foreground text-sm">{t('description')}</p>
      <div className="flex flex-col gap-1">
        <Label htmlFor="remittance-void-reason">{t('reason')}</Label>
        <Textarea
          id="remittance-void-reason"
          rows={2}
          maxLength={RemittanceLimits.NOTE_MAX_LENGTH}
          value={reason}
          onChange={event => setReason(event.target.value)}
        />
      </div>
      {voiding.isError ? (
        <p role="alert" className="text-destructive text-sm">
          {errorText(voiding.error)}
        </p>
      ) : null}
      <Button
        variant="destructive"
        className="self-start"
        disabled={voiding.isPending}
        onClick={ask}
      >
        {t('action')}
      </Button>
    </section>
  )
}

// A draft nobody wants. A confirmed remittance is never deleted: it is voided
export function DiscardButton({ remittance }: { remittance: RemittanceDetailView }): ReactElement {
  const t = useTranslations('remittances.discard')
  const errorText = useErrorText()
  const router = useRouter()
  const { storeId } = useStore()
  const discard = useDiscardRemittance(storeId)
  const [asking, setAsking] = useState(false)
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          discard.reset()
          setAsking(true)
        }}
      >
        {t('action')}
      </Button>
      {discard.isError ? (
        <p role="alert" className="text-destructive text-sm">
          {errorText(discard.error)}
        </p>
      ) : null}
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogContent aria-busy={discard.isPending}>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('dialog.title')}</AlertDialogTitle>
            <AlertDialogDescription>{t('dialog.description')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={discard.isPending}>{t('dialog.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={discard.isPending}
              onClick={event => {
                event.preventDefault()
                discard.mutate(remittance.id, {
                  onSuccess: () => router.push(AppPaths.store.remittances(storeId)),
                  onError: () => setAsking(false)
                })
              }}
            >
              {t('dialog.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
