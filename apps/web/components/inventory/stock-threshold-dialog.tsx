'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useEffect, useState } from 'react'

import { useThresholdChange } from '../../lib/inventory/use-inventory'
import { thresholdOf } from '../../lib/products/product-form'
import { useSubmitGuard } from '../../lib/submit-guard'
import { toast } from '../../lib/toast'
import { MutationError } from '../customers/mutation-error'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import { Input } from '../ui/input'
import { Label } from '../ui/label'

export interface ThresholdTarget {
  productId: string
  productName: string
  threshold: number | null
}

// The alert threshold of a product: the available stock, in all its warehouses, at which the store is warned. Empty
// means no alert. It belongs to the product, not to a warehouse, so changing it here changes it for every row of it.
export function StockThresholdDialog({
  target,
  onClose
}: {
  target: ThresholdTarget | null
  onClose: () => void
}): ReactElement {
  const { storeId } = useStore()
  const change = useThresholdChange(storeId)
  return (
    <Dialog
      open={target !== null}
      // Closing waits for an answer that is on its way
      onOpenChange={next => {
        if (!next && !change.isPending) onClose()
      }}
    >
      <DialogContent>
        {/* Mounted only while open: every opening starts a form of its own */}
        {target === null ? null : (
          <ThresholdForm key={target.productId} target={target} change={change} onDone={onClose} />
        )}
      </DialogContent>
    </Dialog>
  )
}

function ThresholdForm({
  target,
  change,
  onDone
}: {
  target: ThresholdTarget
  change: ReturnType<typeof useThresholdChange>
  onDone: () => void
}): ReactElement {
  const t = useTranslations('stock.threshold')
  const guard = useSubmitGuard()
  const [text, setText] = useState(target.threshold === null ? '' : String(target.threshold))
  const [isWrong, setIsWrong] = useState(false)
  // A mutation outlives the form: the refusal of an earlier opening is not this one's
  const { reset } = change
  useEffect(() => reset(), [reset])

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const threshold = thresholdOf(text)
    if (threshold === undefined) return setIsWrong(true)
    if (!guard.enter()) return
    change.mutate(
      { productId: target.productId, lowStockThreshold: threshold },
      {
        onSuccess: () => {
          toast.success(t('saved'))
          onDone()
        },
        onSettled: guard.leave
      }
    )
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t('title', { product: target.productName })}</DialogTitle>
        <DialogDescription>{t('description')}</DialogDescription>
      </DialogHeader>
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <div className="flex flex-col gap-1">
          <Label htmlFor="stock-threshold">{t('label')}</Label>
          <Input
            id="stock-threshold"
            inputMode="numeric"
            autoComplete="off"
            value={text}
            onChange={event => {
              setText(event.target.value)
              setIsWrong(false)
              change.reset()
            }}
            aria-invalid={isWrong || undefined}
            aria-describedby={isWrong ? 'stock-threshold-error' : 'stock-threshold-help'}
          />
          <p id="stock-threshold-help" className="text-muted-foreground text-sm">
            {t('help')}
          </p>
          {isWrong ? (
            <p id="stock-threshold-error" role="alert" className="text-destructive text-sm">
              {t('invalid')}
            </p>
          ) : null}
        </div>
        <MutationError error={change.error} />
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" disabled={change.isPending} onClick={onDone}>
            {t('cancel')}
          </Button>
          <Button type="submit" busy={change.isPending} disabled={change.isPending}>
            {t('submit')}
          </Button>
        </div>
      </form>
    </>
  )
}
