'use client'

import { useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import type { OrderDetailView } from '@platform/api-client'
import { OrderLimits, type OrderEditableField } from '@platform/core/domain'

import { canEditField } from '../../lib/orders/order-detail-rules'
import type { OrderWrites } from '../../lib/orders/use-order'
import { useStore } from '../providers/store-context'
import { Textarea } from '../ui/textarea'

import { EditableBlock, EditorButtons, type EditorApi } from './order-editable'

type NoteField = Extract<OrderEditableField, 'customerNotes' | 'internalNotes' | 'packingNotes'>

const MAX_LENGTH: Record<NoteField, number> = {
  customerNotes: OrderLimits.CUSTOMER_NOTES_MAX_LENGTH,
  internalNotes: OrderLimits.INTERNAL_NOTES_MAX_LENGTH,
  packingNotes: OrderLimits.PACKING_NOTES_MAX_LENGTH
}

const AMBER_BAND =
  'flex flex-col gap-1.5 rounded-md border border-amber-500/60 bg-amber-50 p-3 text-amber-950 dark:bg-amber-950/30 dark:text-amber-50'

function NoteForm({
  field,
  initial,
  api
}: {
  field: NoteField
  initial: string
  api: EditorApi
}): ReactElement {
  const t = useTranslations('orders.detail.notes')
  const [text, setText] = useState(initial)
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={event => {
        event.preventDefault()
        // A blank note is no note: the api keeps null for "cleared" and "never written"
        const trimmed = text.trim()
        api.save({ [field]: trimmed === '' ? null : trimmed })
      }}
    >
      <Textarea
        rows={4}
        maxLength={MAX_LENGTH[field]}
        value={text}
        aria-label={t(`${field}.label`)}
        onChange={event => setText(event.target.value)}
      />
      <EditorButtons api={api} />
    </form>
  )
}

function Note({
  field,
  value,
  order,
  writes
}: {
  field: NoteField
  value: string | null | undefined
  order: OrderDetailView
  writes: OrderWrites
}): ReactElement | null {
  const t = useTranslations('orders.detail.notes')
  const { can } = useStore()
  // The api leaves a note out for who may not read it: nothing is drawn, not an empty box
  if (value === undefined) return null
  const packing = field === 'packingNotes'
  return (
    <EditableBlock
      heading={t(`${field}.label`)}
      canEdit={canEditField(order.status, field, can)}
      writes={writes}
      band={packing ? AMBER_BAND : undefined}
      form={api => <NoteForm field={field} initial={value ?? ''} api={api} />}
    >
      {value === null || value === '' ? (
        <p className={packing ? '' : 'text-muted-foreground'}>{t('empty')}</p>
      ) : (
        <p className="break-words whitespace-pre-wrap">{value}</p>
      )}
      <p className={packing ? 'mt-1 text-xs' : 'text-muted-foreground mt-1 text-xs'}>
        {t(`${field}.hint`)}
      </p>
    </EditableBlock>
  )
}

// The three notes of the order, each with its own audience: the customer's (the customer and the label of the carrier may
// carry it), the one of customer care (never leaves the team) and the one for packing (the warehouse, in an amber band, never
// to the customer nor the label). A member who may not read the internal ones does not get them from the api and sees nothing.
export function OrderNotes({
  order,
  writes
}: {
  order: OrderDetailView
  writes: OrderWrites
}): ReactElement {
  const t = useTranslations('orders.detail.notes')
  return (
    <section aria-labelledby="order-notes-heading" className="flex flex-col gap-3">
      <h2 id="order-notes-heading" className="text-base font-semibold">
        {t('heading')}
      </h2>
      <Note field="packingNotes" value={order.packingNotes} order={order} writes={writes} />
      <Note field="customerNotes" value={order.customerNotes} order={order} writes={writes} />
      <Note field="internalNotes" value={order.internalNotes} order={order} writes={writes} />
    </section>
  )
}
