'use client'

import { Loader2, PackagePlus, ScanLine } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useEffect, useId, useRef, useState } from 'react'

import { ReceptionBatchStatus, ReceptionScanResults } from '@platform/core/domain'

import {
  hasWorkLeft,
  isBatchOpen,
  isItemEditable,
  openBatchOf
} from '../../lib/returns/reception-form'
import {
  useReceptionBatch,
  useReceptionBatches,
  useReceptionWrites
} from '../../lib/returns/use-reception'
import { useSubmitGuard } from '../../lib/submit-guard'
import { toast } from '../../lib/toast'
import { useErrorText } from '../../lib/use-error-text'
import { useStore } from '../providers/store-context'
import { LoadFailed, PageLoading } from '../settings/states'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { Input } from '../ui/input'
import { Label } from '../ui/label'

import { ReceptionItemCard } from './reception-item-card'
import {
  type AmbiguousQuestion,
  CandidatePicker,
  ConfirmDeliveredDialog,
  type DeliveredQuestion
} from './reception-scan-dialogs'

type Question = AmbiguousQuestion | DeliveredQuestion

// Receiving the packages that come back, at the warehouse desk (TDD_17 §4.16). The batch is saved on the server as it grows, so a
// phone that locks or a tab that closes loses nothing: the screen opens on the newest batch that is still open. A reader types the
// code into the box and presses Enter; the box keeps the focus for the next package. Closing the batch makes a return of each
// package; the ones that fail stay with their error and a second press retries only them.
export function ReceptionScreen(): ReactElement {
  const { storeId } = useStore()
  const t = useTranslations('returns.reception')
  const batches = useReceptionBatches(storeId, true)
  const open = batches.data === undefined ? null : openBatchOf(batches.data)
  if (batches.isError) {
    return <LoadFailed error={batches.error} onRetry={() => void batches.refetch()} />
  }
  if (batches.data === undefined) return <PageLoading />
  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">{t('pageTitle')}</h1>
        <p className="text-muted-foreground text-sm">{t('description')}</p>
      </header>
      {open === null ? <StartBatch /> : <OpenBatch key={open.id} batchId={open.id} />}
    </div>
  )
}

function StartBatch(): ReactElement {
  const t = useTranslations('returns.reception.start')
  const { storeId } = useStore()
  const errorText = useErrorText()
  const guard = useSubmitGuard()
  const writes = useReceptionWrites(storeId, null)
  const start = (): void => {
    if (!guard.enter()) return
    writes.start.mutate(undefined, {
      onError: error => toast.error(errorText(error)),
      onSettled: guard.leave
    })
  }
  return (
    <section className="flex flex-col items-start gap-3 rounded-lg border p-4">
      <p className="text-sm">{t('body')}</p>
      <Button onClick={start} busy={writes.start.isPending}>
        <PackagePlus aria-hidden className="size-4" />
        {t('button')}
      </Button>
    </section>
  )
}

function OpenBatch({ batchId }: { batchId: string }): ReactElement {
  const t = useTranslations('returns.reception')
  const { storeId } = useStore()
  const errorText = useErrorText()
  const scanGuard = useSubmitGuard()
  const closeGuard = useSubmitGuard()
  const ids = useId()
  const batch = useReceptionBatch(storeId, batchId)
  const writes = useReceptionWrites(storeId, batchId)
  const input = useRef<HTMLInputElement>(null)
  const [code, setCode] = useState('')
  const [question, setQuestion] = useState<Question | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [added, setAdded] = useState<string | null>(null)
  const [closing, setClosing] = useState(false)

  const focusBox = (): void => input.current?.focus()
  // The reader types into the box with no click: it takes the focus once the batch is drawn (the box does not exist before)
  const drawn = batch.data !== undefined
  useEffect(() => {
    if (drawn) input.current?.focus()
  }, [drawn])

  if (batch.isError) return <LoadFailed error={batch.error} onRetry={() => void batch.refetch()} />
  if (batch.data === undefined) return <PageLoading />
  const data = batch.data
  const processing = data.status === ReceptionBatchStatus.PROCESSING
  const open = isBatchOpen(data.status)
  const retry = data.status === ReceptionBatchStatus.COMPLETED_WITH_ERRORS

  const send = (body: { code: string; shipmentId?: string; confirmDelivered?: boolean }): void => {
    if (!scanGuard.enter()) return
    setProblem(null)
    setAdded(null)
    writes.scan.mutate(body, {
      onSuccess: result => {
        if (result.result === ReceptionScanResults.ADDED) {
          setQuestion(null)
          setCode('')
          setAdded(result.item.orderNumber)
        } else if (result.result === ReceptionScanResults.NOT_FOUND) {
          setQuestion(null)
          setProblem(t('scan.notFound', { code: body.code }))
        } else {
          setQuestion({ ...result, code: body.code })
        }
      },
      onError: error => {
        setQuestion(null)
        setProblem(errorText(error))
      },
      onSettled: () => {
        scanGuard.leave()
        focusBox()
      }
    })
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const typed = code.trim()
    if (typed === '' || !open) return
    send({ code: typed })
  }

  const complete = (): void => {
    if (!closeGuard.enter()) return
    writes.complete.mutate(undefined, {
      onSettled: closeGuard.leave,
      onSuccess: result => {
        setClosing(false)
        toast[result.status === ReceptionBatchStatus.COMPLETED ? 'success' : 'error'](
          result.status === ReceptionBatchStatus.COMPLETED
            ? t('complete.done', { count: result.counts.received })
            : t('complete.withErrors', {
                received: result.counts.received,
                failed: result.counts.failed
              })
        )
      },
      onError: error => {
        setClosing(false)
        toast.error(errorText(error))
      }
    })
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted-foreground text-sm" aria-live="polite">
        {processing
          ? t('batch.processing')
          : t('batch.counts', {
              total: data.counts.total,
              received: data.counts.received,
              failed: data.counts.failed
            })}
      </p>
      {open ? (
        <form
          onSubmit={submit}
          noValidate
          className="grid gap-1.5"
          aria-label={t('scan.formLabel')}
        >
          <Label htmlFor={`${ids}-code`}>{t('scan.label')}</Label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <ScanLine
                aria-hidden
                className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
              />
              <Input
                id={`${ids}-code`}
                ref={input}
                className="h-12 pl-9 text-base"
                value={code}
                autoComplete="off"
                autoCapitalize="characters"
                enterKeyHint="done"
                inputMode="text"
                onChange={event => {
                  setCode(event.target.value)
                  setProblem(null)
                }}
              />
            </div>
            <Button
              type="submit"
              className="h-12"
              busy={writes.scan.isPending}
              disabled={code.trim() === ''}
            >
              {t('scan.button')}
            </Button>
          </div>
          <p className="text-muted-foreground text-xs">{t('scan.hint')}</p>
          {problem === null ? null : (
            <p role="alert" className="text-destructive text-sm">
              {problem}
            </p>
          )}
          {added === null ? null : (
            <p role="status" className="text-sm">
              {t('scan.added', { order: added })}
            </p>
          )}
        </form>
      ) : null}
      {data.items.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('batch.empty')}</p>
      ) : (
        <ul className="flex flex-col gap-3" aria-label={t('batch.listLabel')}>
          {data.items.map(item => (
            <ReceptionItemCard
              key={item.id}
              item={item}
              cautionPreselected={data.cautionPreselected}
              locked={!open}
              saving={writes.update.isPending}
              removing={writes.remove.isPending}
              onSave={(itemId, body) =>
                writes.update.mutateAsync({ itemId, body }).then(
                  () => true,
                  (error: unknown) => {
                    toast.error(errorText(error))
                    return false
                  }
                )
              }
              onRemove={itemId =>
                writes.remove.mutate(itemId, { onError: error => toast.error(errorText(error)) })
              }
            />
          ))}
        </ul>
      )}
      {(open || processing) && hasWorkLeft(data.items) ? (
        <div className="bg-background sticky bottom-0 flex flex-col gap-2 border-t py-3">
          <Button
            className="h-12"
            onClick={() => setClosing(true)}
            disabled={writes.scan.isPending}
          >
            {retry ? t('complete.retry') : t('complete.button')}
          </Button>
        </div>
      ) : null}
      {processing ? (
        <p className="text-muted-foreground inline-flex items-center gap-2 text-sm">
          <Loader2 aria-hidden className="size-4 animate-spin" />
          {t('batch.processing')}
        </p>
      ) : null}
      {question?.result === ReceptionScanResults.AMBIGUOUS ? (
        <CandidatePicker
          question={question}
          busy={writes.scan.isPending}
          onPick={candidate => send({ code: question.code, shipmentId: candidate.shipmentId })}
          onClose={() => {
            setQuestion(null)
            setCode('')
            focusBox()
          }}
        />
      ) : null}
      {question?.result === ReceptionScanResults.NEEDS_CONFIRMATION ? (
        <ConfirmDeliveredDialog
          question={question}
          busy={writes.scan.isPending}
          onConfirm={() =>
            send({
              code: question.code,
              shipmentId: question.candidate.shipmentId,
              confirmDelivered: true
            })
          }
          onClose={() => {
            setQuestion(null)
            setCode('')
            focusBox()
          }}
        />
      ) : null}
      <Dialog open={closing} onOpenChange={setClosing}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('complete.title')}</DialogTitle>
            <DialogDescription>
              {t('complete.description', {
                count: data.items.filter(isItemEditable).length
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setClosing(false)}
              disabled={writes.complete.isPending}
            >
              {t('complete.cancel')}
            </Button>
            <Button onClick={complete} busy={writes.complete.isPending}>
              {t('complete.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
