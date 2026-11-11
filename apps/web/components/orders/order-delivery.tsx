'use client'

import { Plus, Trash2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type ReactElement, useId, useState } from 'react'

import type { OrderDetailView } from '@platform/api-client'
import { CustomerLimits, OrderLimits, RecipientPhones } from '@platform/core/domain'

import { canEditField } from '../../lib/orders/order-detail-rules'
import {
  addressBody,
  type AddressFields,
  cleanPhones,
  digitsOnly,
  EMPTY_ADDRESS,
  phoneListProblem,
  readAddress
} from '../../lib/orders/order-fields'
import { useDayText } from '../../lib/orders/use-day-text'
import type { OrderWrites } from '../../lib/orders/use-order'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'

import { EditableBlock, EditorButtons, type EditorApi } from './order-editable'

// The delivery of the order: the day it is scheduled for, the address, the phones the carriers call and the tracking number.
// Each block edits where the order accepts it in its status (the table of the api, drawn by `canEditField`).

function ScheduleForm({ initial, api }: { initial: string | null; api: EditorApi }): ReactElement {
  const t = useTranslations('orders.detail.delivery')
  const [day, setDay] = useState(initial ?? '')
  const id = useId()
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={event => {
        event.preventDefault()
        api.save({ scheduledDeliveryDate: day === '' ? null : day })
      }}
    >
      <Label htmlFor={id}>{t('scheduledLabel')}</Label>
      <Input id={id} type="date" value={day} onChange={event => setDay(event.target.value)} />
      <p className="text-muted-foreground text-xs">{t('scheduledHint')}</p>
      <EditorButtons api={api} />
    </form>
  )
}

function PhonesForm({ initial, api }: { initial: string[]; api: EditorApi }): ReactElement {
  const t = useTranslations('orders.detail.delivery')
  const [rows, setRows] = useState<string[]>(initial.length === 0 ? [''] : initial)
  const [touched, setTouched] = useState(false)
  const phones = cleanPhones(rows)
  const problem = phoneListProblem(phones)
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={event => {
        event.preventDefault()
        setTouched(true)
        if (problem === null) api.save({ recipientPhones: phones })
      }}
    >
      <ul className="flex flex-col gap-2">
        {rows.map((row, index) => (
          <li key={index} className="flex items-center gap-2">
            <Input
              inputMode="tel"
              value={row}
              aria-label={t('phoneN', { number: index + 1 })}
              onChange={event =>
                setRows(rows.map((value, at) => (at === index ? event.target.value : value)))
              }
              // The carriers take national digits and nothing else: what is typed is cleaned when the field is left
              onBlur={() =>
                setRows(rows.map((value, at) => (at === index ? digitsOnly(value) : value)))
              }
            />
            {rows.length > 1 ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t('removePhone', { number: index + 1 })}
                onClick={() => setRows(rows.filter((_, at) => at !== index))}
              >
                <Trash2 aria-hidden />
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {rows.length < RecipientPhones.MAX_COUNT ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => setRows([...rows, ''])}
        >
          <Plus aria-hidden />
          {t('addPhone')}
        </Button>
      ) : null}
      <p className="text-muted-foreground text-xs">
        {t('phonesHint', { max: RecipientPhones.MAX_COUNT })}
      </p>
      {touched && problem !== null ? (
        <p role="alert" className="text-destructive text-sm">
          {t(`phoneProblem.${problem}`, {
            min: RecipientPhones.MIN_DIGITS,
            max: RecipientPhones.MAX_DIGITS
          })}
        </p>
      ) : null}
      <EditorButtons api={api} />
    </form>
  )
}

const ADDRESS_FIELDS = ['line1', 'line2', 'city', 'state', 'postalCode', 'country'] as const

function AddressForm({
  initial,
  api
}: {
  initial: AddressFields | null
  api: EditorApi
}): ReactElement {
  const t = useTranslations('orders.detail.delivery')
  const [fields, setFields] = useState<AddressFields>(initial ?? EMPTY_ADDRESS)
  const [touched, setTouched] = useState(false)
  const base = useId()
  const body = addressBody(fields)
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={event => {
        event.preventDefault()
        setTouched(true)
        if (body !== null) api.save({ shippingAddress: body })
      }}
    >
      {ADDRESS_FIELDS.map(field => (
        <div key={field} className="flex flex-col gap-1">
          <Label htmlFor={`${base}-${field}`}>{t(`address.${field}`)}</Label>
          <Input
            id={`${base}-${field}`}
            value={fields[field]}
            maxLength={
              field === 'postalCode'
                ? CustomerLimits.ADDRESS_POSTAL_CODE_MAX_LENGTH
                : field === 'country'
                  ? 2
                  : CustomerLimits.ADDRESS_FIELD_MAX_LENGTH
            }
            onChange={event => setFields({ ...fields, [field]: event.target.value })}
          />
        </div>
      ))}
      {touched && body === null ? (
        <p role="alert" className="text-destructive text-sm">
          {t('addressProblem')}
        </p>
      ) : null}
      <EditorButtons api={api} />
    </form>
  )
}

function TrackingForm({ initial, api }: { initial: string; api: EditorApi }): ReactElement {
  const t = useTranslations('orders.detail.delivery')
  const [text, setText] = useState(initial)
  const id = useId()
  const trimmed = text.trim()
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={event => {
        event.preventDefault()
        api.save({ trackingNumber: trimmed === '' ? null : trimmed })
      }}
    >
      <Label htmlFor={id}>{t('trackingLabel')}</Label>
      <Input
        id={id}
        value={text}
        maxLength={OrderLimits.TRACKING_NUMBER_MAX_LENGTH}
        onChange={event => setText(event.target.value)}
      />
      <EditorButtons api={api} />
    </form>
  )
}

export function OrderDelivery({
  order,
  writes
}: {
  order: OrderDetailView
  writes: OrderWrites
}): ReactElement {
  const t = useTranslations('orders.detail.delivery')
  const dayText = useDayText()
  const { can } = useStore()
  const address = readAddress(order.shippingAddress)
  const editable = (field: Parameters<typeof canEditField>[1]): boolean =>
    canEditField(order.status, field, can)
  return (
    <section aria-labelledby="order-delivery-heading" className="flex flex-col gap-3">
      <h2 id="order-delivery-heading" className="text-base font-semibold">
        {t('heading')}
      </h2>
      <EditableBlock
        heading={t('scheduled')}
        canEdit={editable('scheduledDeliveryDate')}
        writes={writes}
        form={api => <ScheduleForm initial={order.scheduledDeliveryDate} api={api} />}
      >
        {order.scheduledDeliveryDate === null ? (
          <p className="text-muted-foreground">{t('notScheduled')}</p>
        ) : (
          <p>{dayText(order.scheduledDeliveryDate)}</p>
        )}
      </EditableBlock>
      <EditableBlock
        heading={t('addressHeading')}
        canEdit={editable('address')}
        writes={writes}
        form={api => <AddressForm initial={address} api={api} />}
      >
        {address === null ? (
          <p className="text-muted-foreground">{t('noAddress')}</p>
        ) : (
          <address className="not-italic">
            <p>{address.line1}</p>
            {address.line2 === '' ? null : <p>{address.line2}</p>}
            <p>
              {[address.city, address.state, address.postalCode]
                .filter(part => part !== '')
                .join(', ')}
            </p>
            {address.country === '' ? null : <p>{address.country}</p>}
          </address>
        )}
      </EditableBlock>
      <EditableBlock
        heading={t('phones')}
        canEdit={editable('recipientPhones')}
        writes={writes}
        form={api => <PhonesForm initial={order.recipientPhones} api={api} />}
      >
        {order.recipientPhones.length === 0 ? (
          <p className="text-muted-foreground">{t('noPhones')}</p>
        ) : (
          <ul>
            {order.recipientPhones.map(phone => (
              <li key={phone}>{phone}</li>
            ))}
          </ul>
        )}
      </EditableBlock>
      {order.trackingNumber !== null || editable('trackingNumber') ? (
        <EditableBlock
          heading={t('tracking')}
          canEdit={editable('trackingNumber')}
          writes={writes}
          form={api => <TrackingForm initial={order.trackingNumber ?? ''} api={api} />}
        >
          {order.trackingNumber === null ? (
            <p className="text-muted-foreground">{t('noTracking')}</p>
          ) : (
            <p>{order.trackingNumber}</p>
          )}
        </EditableBlock>
      ) : null}
    </section>
  )
}
