'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useState } from 'react'

import { CustomerLimits } from '@platform/core/domain'

import { useCustomerCaution } from '../../lib/customers/use-customer-data'
import { useSubmitGuard } from '../../lib/submit-guard'
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
import { Input } from '../ui/input'
import { Label } from '../ui/label'

import { MutationError } from './mutation-error'

// Flag a customer with caution (the reason is required, and it replaces the old one) or take the flag off. It loads
// when it is first opened: the inbox panel draws the profile and the inbox has a script budget.
export function CautionDialog({
  customerId,
  isFlagged,
  currentReason,
  onClose
}: {
  customerId: string
  isFlagged: boolean
  currentReason: string | null
  onClose: () => void
}): ReactElement {
  const t = useTranslations('customers.cautionFlag')
  const { storeId } = useStore()
  const { set, clear } = useCustomerCaution(storeId, customerId)
  const guard = useSubmitGuard()
  const [mode, setMode] = useState<'set' | 'clear'>(isFlagged ? 'clear' : 'set')
  const [reason, setReason] = useState(mode === 'set' ? (currentReason ?? '') : '')
  const isBusy = set.isPending || clear.isPending
  const trimmed = reason.trim()
  const error = mode === 'set' ? set.error : clear.error

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (mode === 'set' && trimmed === '') return
    if (!guard.enter()) return
    const options = { onSuccess: onClose, onSettled: guard.leave }
    if (mode === 'set') set.mutate(trimmed, options)
    else clear.mutate(undefined, options)
  }

  return (
    // Not closed while it is saved: the answer, a refusal included, must reach the agent
    <Dialog open onOpenChange={open => (open || isBusy ? undefined : onClose())}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{t(`${mode}.title`)}</DialogTitle>
            <DialogDescription>{t(`${mode}.description`)}</DialogDescription>
          </DialogHeader>
          {mode === 'set' ? (
            <div className="flex flex-col gap-1">
              <Label htmlFor="caution-reason">{t('reason')}</Label>
              <Input
                id="caution-reason"
                autoComplete="off"
                required
                maxLength={CustomerLimits.CAUTION_REASON_MAX_LENGTH}
                value={reason}
                onChange={event => {
                  setReason(event.target.value)
                  set.reset()
                }}
              />
              <p className="text-muted-foreground text-xs">{t('reasonHelp')}</p>
            </div>
          ) : (
            <>
              {currentReason === null ? null : (
                <p className="bg-muted rounded-md p-2 text-sm">{currentReason}</p>
              )}
              <button
                type="button"
                className="text-muted-foreground self-start text-xs underline"
                onClick={() => {
                  setMode('set')
                  setReason(currentReason ?? '')
                }}
              >
                {t('changeReason')}
              </button>
            </>
          )}
          <MutationError error={error} />
          <DialogFooter>
            <Button type="button" variant="outline" disabled={isBusy} onClick={onClose}>
              {t('cancel')}
            </Button>
            <Button
              type="submit"
              busy={isBusy}
              disabled={isBusy || (mode === 'set' && trimmed === '')}
            >
              {t(`${mode}.submit`)}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
