'use client'

import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import type { ScanResultView } from '@platform/api-client'
import type { ReceptionScanResults } from '@platform/core/domain'

import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'

type Scan<R extends ScanResultView['result']> = Extract<ScanResultView, { result: R }>
type Candidate = Scan<typeof ReceptionScanResults.AMBIGUOUS>['candidates'][number]

// What the reader typed needs a decision of the agent before the package joins the batch (TDD_17 §4.16): the api's own answer
// plus the code that was typed, which the next scan repeats
export type AmbiguousQuestion = Scan<typeof ReceptionScanResults.AMBIGUOUS> & { code: string }
export type DeliveredQuestion = Scan<typeof ReceptionScanResults.NEEDS_CONFIRMATION> & {
  code: string
}

// More than one shipment answers to the code: the agent picks the one in their hands
export function CandidatePicker({
  question,
  busy,
  onPick,
  onClose
}: {
  question: AmbiguousQuestion
  busy: boolean
  onPick: (candidate: Candidate) => void
  onClose: () => void
}): ReactElement {
  const t = useTranslations('returns.reception.picker')
  return (
    <Dialog open onOpenChange={open => (open ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description', { code: question.code })}</DialogDescription>
        </DialogHeader>
        <ul className="flex flex-col gap-2">
          {question.candidates.map(candidate => (
            <li key={candidate.shipmentId}>
              <Button
                variant="outline"
                className="h-auto w-full justify-start py-3 text-left"
                disabled={busy}
                onClick={() => onPick(candidate)}
              >
                {t('option', {
                  order: candidate.orderNumber,
                  guide: candidate.guideNumber ?? t('noGuide')
                })}
              </Button>
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t('cancel')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// The guide says the package was delivered, and it is here: it joins the batch only if the agent confirms that it came back
export function ConfirmDeliveredDialog({
  question,
  busy,
  onConfirm,
  onClose
}: {
  question: DeliveredQuestion
  busy: boolean
  onConfirm: () => void
  onClose: () => void
}): ReactElement {
  const t = useTranslations('returns.reception.confirmDelivered')
  return (
    <Dialog open onOpenChange={open => (open ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>
            {t('description', {
              order: question.candidate.orderNumber,
              guide: question.candidate.guideNumber ?? t('noGuide')
            })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('cancel')}
          </Button>
          <Button onClick={onConfirm} busy={busy}>
            {t('confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
