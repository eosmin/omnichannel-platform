'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useState } from 'react'

import type { CustomerChanges, CustomerDetailView } from '@platform/api-client'
import { CustomerLimits } from '@platform/core/domain'

import { changedFields } from '../../lib/customers/customer-form'
import { useCustomerEdits } from '../../lib/customers/use-customer-data'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'

import { MutationError } from './mutation-error'

// Name, e-mail and phone of the customer. An emptied field clears the value. The api normalizes the
// phone and refuses one that is not valid, and the form shows that answer instead of judging it.
export function ProfileForm({
  customer,
  onDone
}: {
  customer: CustomerDetailView
  onDone: () => void
}): ReactElement {
  const t = useTranslations('customers.edit')
  const tAll = useTranslations()
  const { storeId } = useStore()
  const { update } = useCustomerEdits(storeId, customer.id)
  const [values, setValues] = useState({
    name: customer.name ?? '',
    email: customer.email ?? '',
    phone: customer.phone ?? ''
  })

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const changes: CustomerChanges = changedFields(customer, values)
    if (Object.keys(changes).length === 0) {
      onDone()
      return
    }
    update.mutate(changes, { onSuccess: onDone })
  }
  const field = (key: keyof typeof values, label: string, max: number, type = 'text') => (
    <div className="flex flex-col gap-1">
      <Label htmlFor={`customer-${key}`}>{label}</Label>
      <Input
        id={`customer-${key}`}
        type={type}
        maxLength={max}
        value={values[key]}
        onChange={event => setValues(current => ({ ...current, [key]: event.target.value }))}
      />
    </div>
  )

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      {field('name', t('name'), CustomerLimits.NAME_MAX_LENGTH)}
      {field('email', t('email'), CustomerLimits.EMAIL_MAX_LENGTH, 'email')}
      {field('phone', t('phone'), CustomerLimits.CHANNEL_IDENTITY_MAX_LENGTH, 'tel')}
      <MutationError error={update.error} />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={update.isPending}>
          {t('save')}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          {tAll('common.cancel')}
        </Button>
      </div>
    </form>
  )
}
