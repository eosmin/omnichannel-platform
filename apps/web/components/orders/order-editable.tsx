'use client'

import { Pencil } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type ReactElement, type ReactNode, useId, useState } from 'react'

import type { UpdateOrderInput } from '@platform/core/domain'

import type { OrderWrites } from '../../lib/orders/use-order'
import { toast } from '../../lib/toast'
import { MutationError } from '../customers/mutation-error'
import { Button } from '../ui/button'

export interface EditorApi {
  // Sends the changes of one edit; the screen goes back to reading when the api accepts them
  save: (changes: UpdateOrderInput) => void
  cancel: () => void
  pending: boolean
}

// A block of the detail that reads, and edits in place when the order accepts the edit in its status (the api's table, drawn
// by `canEdit`). A block that cannot be edited says nothing about editing: no disabled button that asks a question. One save at
// a time: the order is one row, so every block shares the pending state of the write.
export function EditableBlock({
  heading,
  canEdit,
  writes,
  band,
  children,
  form
}: {
  heading: string
  canEdit: boolean
  writes: OrderWrites
  // The look of the block (the packing note is an amber band)
  band?: string
  children: ReactNode
  form: (api: EditorApi) => ReactElement
}): ReactElement {
  const t = useTranslations('orders.detail')
  const [wanted, setEditing] = useState(false)
  // The order changed under an open form (another agent moved it): the field is no longer editable and the form goes
  const editing = wanted && canEdit
  // ... and it does not come back by itself if the field becomes editable again later
  if (wanted && !canEdit) setEditing(false)
  // Only the block that sent the write shows its refusal: the write state is shared by every block of the order
  const [sent, setSent] = useState(false)
  const headingId = useId()
  const close = (): void => {
    writes.update.reset()
    setSent(false)
    setEditing(false)
  }
  const save = (changes: UpdateOrderInput): void => {
    setSent(true)
    writes.update.mutate(changes, {
      onSuccess: () => {
        toast.success(t('saved'))
        close()
      }
    })
  }
  return (
    <section aria-labelledby={headingId} className={band ?? 'flex flex-col gap-1.5'}>
      <div className="flex items-center justify-between gap-2">
        <h3 id={headingId} className="text-sm font-semibold">
          {heading}
        </h3>
        {canEdit && !editing && !writes.update.isPending ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={t('editField', { field: heading })}
            onClick={() => {
              writes.update.reset()
              setEditing(true)
            }}
          >
            <Pencil aria-hidden />
            {t('edit')}
          </Button>
        ) : null}
      </div>
      {editing ? (
        <div className="flex flex-col gap-2">
          {form({ save, cancel: close, pending: sent && writes.update.isPending })}
          <MutationError error={sent ? writes.update.error : null} />
        </div>
      ) : (
        <div className="text-sm">{children}</div>
      )}
    </section>
  )
}

// The buttons of every form of a block
export function EditorButtons({
  api,
  disabled
}: {
  api: EditorApi
  disabled?: boolean
}): ReactElement {
  const t = useTranslations('common')
  return (
    <div className="flex gap-2">
      <Button type="submit" size="sm" disabled={api.pending || disabled} busy={api.pending}>
        {t('save')}
      </Button>
      <Button type="button" variant="outline" size="sm" disabled={api.pending} onClick={api.cancel}>
        {t('cancel')}
      </Button>
    </div>
  )
}
