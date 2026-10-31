'use client'

import { Pencil, Plus, Trash2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useState } from 'react'

import type { CustomerAddressView, CustomerDetailView } from '@platform/api-client'
import { CustomerLimits } from '@platform/core/domain'

import {
  type AddressValues,
  addressChanges,
  addressValuesOf,
  EMPTY_ADDRESS,
  newAddress
} from '../../lib/customers/customer-form'
import { useCustomerEdits } from '../../lib/customers/use-customer-data'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'

import { MutationError } from './mutation-error'

type Text = Exclude<keyof AddressValues, 'isDefault'>

const FIELDS: readonly { key: Text; max: number; required?: boolean }[] = [
  { key: 'label', max: CustomerLimits.ADDRESS_LABEL_MAX_LENGTH },
  { key: 'line1', max: CustomerLimits.ADDRESS_FIELD_MAX_LENGTH, required: true },
  { key: 'line2', max: CustomerLimits.ADDRESS_FIELD_MAX_LENGTH },
  { key: 'city', max: CustomerLimits.ADDRESS_FIELD_MAX_LENGTH, required: true },
  { key: 'state', max: CustomerLimits.ADDRESS_FIELD_MAX_LENGTH },
  { key: 'postalCode', max: CustomerLimits.ADDRESS_POSTAL_CODE_MAX_LENGTH },
  // ISO 3166-1 alpha-2: the api refuses anything else
  { key: 'country', max: 2 }
]

function AddressForm({
  initial,
  idPrefix,
  isPending,
  error,
  onSubmit,
  onCancel
}: {
  initial: AddressValues
  idPrefix: string
  isPending: boolean
  error: Error | null
  onSubmit: (values: AddressValues) => void
  onCancel: () => void
}): ReactElement {
  const t = useTranslations('customers.edit.address')
  const tAll = useTranslations()
  const [values, setValues] = useState(initial)
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    onSubmit(values)
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      {FIELDS.map(({ key, max, required }) => (
        <div key={key} className="flex flex-col gap-1">
          <Label htmlFor={`${idPrefix}-${key}`}>{t(`fields.${key}`)}</Label>
          <Input
            id={`${idPrefix}-${key}`}
            maxLength={max}
            required={required}
            value={values[key]}
            onChange={event => setValues(current => ({ ...current, [key]: event.target.value }))}
          />
        </div>
      ))}
      <Label className="gap-2">
        <input
          type="checkbox"
          checked={values.isDefault}
          onChange={event =>
            setValues(current => ({ ...current, isDefault: event.target.checked }))
          }
        />
        {t('makeDefault')}
      </Label>
      <MutationError error={error} />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={isPending}>
          {t('save')}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          {tAll('common.cancel')}
        </Button>
      </div>
    </form>
  )
}

function AddressRow({
  customerId,
  address
}: {
  customerId: string
  address: CustomerAddressView
}): ReactElement {
  const t = useTranslations('customers.edit.address')
  const tProfile = useTranslations('customers.profile')
  const { storeId } = useStore()
  const { editAddress, removeAddress } = useCustomerEdits(storeId, customerId)
  const [isEditing, setEditing] = useState(false)
  const title = [address.label, address.isDefault ? tProfile('defaultAddress') : null]
    .filter(part => part !== null)
    .join(' · ')

  if (isEditing) {
    return (
      <li>
        <AddressForm
          initial={addressValuesOf(address)}
          idPrefix={`address-${address.id}`}
          isPending={editAddress.isPending}
          error={editAddress.error}
          onCancel={() => setEditing(false)}
          onSubmit={values => {
            const changes = addressChanges(address, values)
            if (Object.keys(changes).length === 0) {
              setEditing(false)
              return
            }
            editAddress.mutate(
              { addressId: address.id, changes },
              { onSuccess: () => setEditing(false) }
            )
          }}
        />
      </li>
    )
  }
  return (
    <li className="flex items-start gap-1 text-sm">
      <div className="min-w-0 flex-1">
        {title === '' ? null : <p className="font-medium">{title}</p>}
        <p className="text-muted-foreground">
          {[
            address.line1,
            address.line2,
            address.city,
            address.state,
            address.postalCode,
            address.country
          ]
            .filter((part): part is string => part !== null && part !== '')
            .join(', ')}
        </p>
        <MutationError error={removeAddress.error} />
      </div>
      <Button
        size="icon"
        variant="ghost"
        className="size-7"
        aria-label={t('edit')}
        onClick={() => setEditing(true)}
      >
        <Pencil />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="size-7"
        aria-label={t('remove')}
        disabled={removeAddress.isPending}
        onClick={() => removeAddress.mutate(address.id)}
      >
        <Trash2 />
      </Button>
    </li>
  )
}

// The addresses of the customer with their edit, delete and add (TDD_09 §6)
export function AddressEditor({ customer }: { customer: CustomerDetailView }): ReactElement {
  const t = useTranslations('customers.edit.address')
  const tProfile = useTranslations('customers.profile')
  const { storeId } = useStore()
  const { addAddress } = useCustomerEdits(storeId, customer.id)
  const [isAdding, setAdding] = useState(false)

  return (
    <div className="flex flex-col gap-2">
      {customer.addresses.length === 0 ? (
        <p className="text-muted-foreground text-sm">{tProfile('noAddresses')}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {customer.addresses.map(address => (
            <AddressRow key={address.id} customerId={customer.id} address={address} />
          ))}
        </ul>
      )}
      {isAdding ? (
        <AddressForm
          initial={EMPTY_ADDRESS}
          idPrefix="address-new"
          isPending={addAddress.isPending}
          error={addAddress.error}
          onCancel={() => setAdding(false)}
          onSubmit={values =>
            addAddress.mutate(newAddress(values), { onSuccess: () => setAdding(false) })
          }
        />
      ) : (
        <Button size="sm" variant="ghost" className="self-start" onClick={() => setAdding(true)}>
          <Plus />
          {t('add')}
        </Button>
      )}
    </div>
  )
}
