'use client'

import { useTranslations } from 'next-intl'
import { type ReactElement, useId, useState } from 'react'

import type { TransferView } from '@platform/api-client'
import { TransferShortageAction } from '@platform/core/domain'

import { useSubmitGuard } from '../../lib/submit-guard'
import { toast } from '../../lib/toast'
import { closeInputOf, type ShortageChoices, shortLinesOf } from '../../lib/transfers/transfer-form'
import { useCloseTransfer } from '../../lib/transfers/use-transfers'
import { useErrorText } from '../../lib/use-error-text'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'

const ACTIONS = [TransferShortageAction.RETURN_TO_SOURCE, TransferShortageAction.WRITE_OFF] as const

// Closing a transfer that will not arrive in full: each line that is short says what happens to the units that are
// missing (they go back to the origin, or they are written off as lost). Nothing is closed until each has an answer.
export function TransferCloseDialog(props: {
  transfer: TransferView
  storeId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}): ReactElement {
  // A new opening starts from what the transfer holds now: no old choices, no old refusal
  return <CloseDialogBody key={`${props.open}-${props.transfer.updatedAt}`} {...props} />
}

function CloseDialogBody({
  transfer,
  storeId,
  open,
  onOpenChange
}: {
  transfer: TransferView
  storeId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}): ReactElement {
  const t = useTranslations('transfers.close')
  const errorText = useErrorText()
  const guard = useSubmitGuard()
  const close = useCloseTransfer(storeId, transfer.id)
  const [choices, setChoices] = useState<ShortageChoices>({})
  const [refusal, setRefusal] = useState<string | null>(null)
  const [missing, setMissing] = useState(false)
  const short = shortLinesOf(transfer.lines)
  const idPrefix = useId()

  const submit = (): void => {
    const lines = closeInputOf(transfer.lines, choices)
    if (lines === null) {
      setMissing(true)
      return
    }
    if (!guard.enter()) return
    close.mutate(
      { lines },
      {
        onSuccess: () => {
          toast.success(t('done'))
          onOpenChange(false)
        },
        onError: error => setRefusal(errorText(error)),
        onSettled: guard.leave
      }
    )
  }

  return (
    <Dialog
      open={open}
      onOpenChange={next => (next || !close.isPending ? onOpenChange(next) : undefined)}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        {short.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('nothingShort')}</p>
        ) : (
          <div className="flex flex-col gap-3">
            {short.map(line => {
              const name =
                line.variantName === null
                  ? line.productName
                  : `${line.productName} · ${line.variantName}`
              return (
                <fieldset key={line.id} className="flex flex-col gap-2 rounded-lg border p-3">
                  <legend className="px-1 text-sm font-medium">
                    {t('missingOf', { name, count: line.pendingQuantity })}
                  </legend>
                  {ACTIONS.map(action => (
                    <label
                      key={action}
                      className="flex items-start gap-2 text-sm pointer-coarse:min-h-10"
                    >
                      <input
                        type="radio"
                        name={`${idPrefix}-${line.id}`}
                        className="mt-1"
                        checked={choices[line.id] === action}
                        onChange={() => {
                          setChoices(current => ({ ...current, [line.id]: action }))
                          setMissing(false)
                          setRefusal(null)
                        }}
                      />
                      <span className="flex flex-col">
                        <span>{t(`actions.${action}.label`)}</span>
                        <span className="text-muted-foreground text-xs">
                          {t(`actions.${action}.hint`, { warehouse: transfer.fromWarehouse.name })}
                        </span>
                      </span>
                    </label>
                  ))}
                </fieldset>
              )
            })}
          </div>
        )}
        {missing ? (
          <p role="alert" className="text-destructive text-sm">
            {t('chooseAll')}
          </p>
        ) : null}
        {refusal === null ? null : (
          <p role="alert" className="text-destructive text-sm">
            {refusal}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={close.isPending}
            onClick={() => onOpenChange(false)}
          >
            {t('back')}
          </Button>
          <Button
            type="button"
            busy={close.isPending}
            disabled={short.length === 0}
            onClick={submit}
          >
            {t('submit')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
