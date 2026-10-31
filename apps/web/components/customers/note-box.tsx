'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useState } from 'react'

import { CustomerLimits } from '@platform/core/domain'

import { useCustomerEdits } from '../../lib/customers/use-customer-data'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { Textarea } from '../ui/textarea'

import { MutationError } from './mutation-error'

// A note about the customer, seen by the team in the activity below
export function NoteBox({ customerId }: { customerId: string }): ReactElement {
  const t = useTranslations('customers.edit.note')
  const { storeId } = useStore()
  const { addNote } = useCustomerEdits(storeId, customerId)
  const [content, setContent] = useState('')
  const text = content.trim()

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (text === '') return
    addNote.mutate(text, { onSuccess: () => setContent('') })
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <Label htmlFor="customer-note">{t('label')}</Label>
      <Textarea
        id="customer-note"
        rows={3}
        maxLength={CustomerLimits.NOTE_MAX_LENGTH}
        value={content}
        onChange={event => setContent(event.target.value)}
      />
      <MutationError error={addNote.error} />
      <Button
        type="submit"
        size="sm"
        className="self-start"
        disabled={text === '' || addNote.isPending}
      >
        {t('add')}
      </Button>
    </form>
  )
}
