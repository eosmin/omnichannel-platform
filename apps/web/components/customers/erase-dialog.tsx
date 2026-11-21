'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useState } from 'react'

import { useCustomerErasure } from '../../lib/customers/use-customer-data'
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

const ERASES = ['contact', 'notes', 'fiscal', 'messages', 'handles', 'caution'] as const
const KEEPS = ['books', 'threads', 'consent'] as const

// The strong confirmation of the erasure of a customer (TDD_05 §10.3): it says what goes and what stays, and the agent types
// a word before the button works. Irreversible, so it is not closed while the call runs: the answer, a refusal included, must
// reach the agent. It loads when it is first opened, like the other dialogs of the profile.
export function EraseDialog({
  customerId,
  onClose
}: {
  customerId: string
  onClose: () => void
}): ReactElement {
  const t = useTranslations('customers.erasure')
  const { storeId } = useStore()
  const erasure = useCustomerErasure(storeId, customerId)
  const guard = useSubmitGuard()
  const [typed, setTyped] = useState('')
  const word = t('confirmWord')
  const isConfirmed = typed.trim() === word

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (!isConfirmed || !guard.enter()) return
    erasure.mutate(undefined, { onSuccess: onClose, onSettled: guard.leave })
  }

  return (
    <Dialog open onOpenChange={open => (open || erasure.isPending ? undefined : onClose())}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{t('title')}</DialogTitle>
            <DialogDescription>{t('description')}</DialogDescription>
          </DialogHeader>
          <section className="flex flex-col gap-1">
            <h3 className="text-sm font-semibold">{t('erasesTitle')}</h3>
            <ul className="list-disc pl-5 text-sm">
              {ERASES.map(key => (
                <li key={key}>{t(`erases.${key}`)}</li>
              ))}
            </ul>
          </section>
          <section className="flex flex-col gap-1">
            <h3 className="text-sm font-semibold">{t('keepsTitle')}</h3>
            <ul className="list-disc pl-5 text-sm">
              {KEEPS.map(key => (
                <li key={key}>{t(`keeps.${key}`)}</li>
              ))}
            </ul>
          </section>
          <div className="flex flex-col gap-1">
            <Label htmlFor="erase-confirm">{t('confirmLabel', { word })}</Label>
            <Input
              id="erase-confirm"
              autoComplete="off"
              value={typed}
              onChange={event => {
                setTyped(event.target.value)
                erasure.reset()
              }}
            />
          </div>
          <MutationError error={erasure.error} />
          <DialogFooter>
            <Button type="button" variant="outline" disabled={erasure.isPending} onClick={onClose}>
              {t('cancel')}
            </Button>
            <Button
              type="submit"
              variant="destructive"
              busy={erasure.isPending}
              disabled={erasure.isPending || !isConfirmed}
            >
              {t('submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
