'use client'

import dynamic from 'next/dynamic'
import { useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import {
  ApiError,
  type CreatedCustomerView,
  type CustomerDetailView,
  fetchCustomer
} from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'
import { CustomerLimits, DuplicateMatches } from '@platform/core/domain'
import { ClientErrorCodes } from '@platform/core/errors'

import { apiClient } from '../../lib/api'
import { customerListLabel } from '../../lib/customers/customer-name'
import { useCustomerList } from '../../lib/customers/use-customer-data'
import { newCustomerBody } from '../../lib/orders/order-form'
import { useCreateCustomer } from '../../lib/orders/use-create-order'
import { useSubmitGuard } from '../../lib/submit-guard'
import { useDebouncedValue } from '../../lib/use-debounced-value'
import { MutationError } from '../customers/mutation-error'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'

// The merge dialog of Step 3.3 loads only when someone asks for it
const MergeDialog = dynamic(
  () => import('../customers/merge-dialog').then(module => module.MergeDialog),
  { ssr: false }
)

const SEARCH_DELAY_MS = 300

type Duplicates = CreatedCustomerView['possibleDuplicates']

// Who the order is for: the customer of the conversation, one found by name, e-mail or phone, or a new one made here
// (`customers:create`). A new customer that looks like an old one is saved all the same and the old ones are listed
// with the reason, and a button that opens the merge dialog with the old one as survivor.
export function OrderCustomerField({
  customerId,
  customer,
  isLoading,
  onChoose
}: {
  customerId: string | null
  // Null when it is not loaded or the member may not read customers
  customer: CustomerDetailView | undefined
  isLoading: boolean
  onChoose: (customerId: string | null) => void
}): ReactElement {
  const t = useTranslations('orders.create.customer')
  const { storeId, can } = useStore()
  const mayView = can(ClientPermissions.CUSTOMERS_VIEW)
  const mayCreate = can(ClientPermissions.CUSTOMERS_CREATE)
  const [mode, setMode] = useState<'search' | 'new'>('search')
  const [duplicates, setDuplicates] = useState<{ newId: string; rows: Duplicates } | null>(null)
  const [merging, setMerging] = useState<string | null>(null)
  const label = customer === undefined ? null : (customerListLabel(customer) ?? t('unnamed'))

  // After the dialog: is the new customer gone (a merge absorbed it)? Anything else, a failed read included, keeps it.
  const wasAbsorbed = async (id: string): Promise<boolean> => {
    try {
      await fetchCustomer(apiClient, storeId, id)
      return false
    } catch (error) {
      return error instanceof ApiError && error.code === ClientErrorCodes.RESOURCE_NOT_FOUND
    }
  }

  if (customerId !== null) {
    return (
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">{t('label')}</span>
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3">
          <span className="min-w-0 break-words" data-testid="order-customer">
            {isLoading ? t('loading') : (label ?? t('unnamed'))}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setDuplicates(null)
              setMode('search')
              onChoose(null)
            }}
          >
            {t('change')}
          </Button>
        </div>
        {duplicates !== null && duplicates.rows.length > 0 ? (
          <section
            aria-label={t('duplicates.title')}
            className="flex flex-col gap-2 rounded-md border border-amber-500/60 p-3"
          >
            <h3 className="text-sm font-medium">{t('duplicates.title')}</h3>
            <p className="text-muted-foreground text-xs">{t('duplicates.help')}</p>
            <ul className="flex flex-col gap-2">
              {duplicates.rows.map(row => {
                const name = customerListLabel(row) ?? t('unnamed')
                return (
                  <li key={row.id} className="flex flex-col gap-1 text-sm">
                    <span className="break-words">{name}</span>
                    <span className="text-muted-foreground text-xs">
                      {row.matchedOn
                        .map(match =>
                          match === DuplicateMatches.EMAIL
                            ? t('duplicates.matchedOn.email')
                            : t('duplicates.matchedOn.phone')
                        )
                        .join(' · ')}
                    </span>
                    {can(ClientPermissions.CUSTOMERS_MERGE) ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="self-start"
                        onClick={() => setMerging(row.id)}
                      >
                        {t('duplicates.merge', { name })}
                      </Button>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          </section>
        ) : null}
        {merging !== null && duplicates !== null ? (
          <MergeDialog
            survivorId={merging}
            absorbedId={duplicates.newId}
            onClose={() => {
              const survivor = merging
              const absorbed = duplicates.newId
              setMerging(null)
              // A merge that went through absorbed the new customer: the order is for the survivor
              void wasAbsorbed(absorbed).then(isAbsorbed => {
                if (isAbsorbed) {
                  setDuplicates(null)
                  onChoose(survivor)
                }
              })
            }}
          />
        ) : null}
      </div>
    )
  }

  return mode === 'new' ? (
    <NewCustomer
      onCancel={() => setMode('search')}
      onCreated={created => {
        setDuplicates({ newId: created.id, rows: created.possibleDuplicates })
        onChoose(created.id)
      }}
    />
  ) : (
    <CustomerSearch
      mayView={mayView}
      mayCreate={mayCreate}
      onNew={() => setMode('new')}
      onChoose={onChoose}
    />
  )
}

function CustomerSearch({
  mayView,
  mayCreate,
  onNew,
  onChoose
}: {
  mayView: boolean
  mayCreate: boolean
  onNew: () => void
  onChoose: (customerId: string) => void
}): ReactElement {
  const t = useTranslations('orders.create.customer')
  const { storeId } = useStore()
  const [text, setText] = useState('')
  const q = useDebouncedValue(text.trim(), SEARCH_DELAY_MS)
  const customers = useCustomerList(storeId, q, mayView && q.length >= 2)
  const rows = customers.data?.pages.flatMap(page => page.data) ?? []
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="order-customer-search">{t('label')}</Label>
      {mayView ? (
        <>
          <Input
            id="order-customer-search"
            type="search"
            autoComplete="off"
            maxLength={CustomerLimits.SEARCH_MAX_LENGTH}
            placeholder={t('searchPlaceholder')}
            aria-label={t('searchLabel')}
            value={text}
            onChange={event => setText(event.target.value)}
          />
          {customers.isError && rows.length === 0 ? (
            <p role="alert" className="text-destructive text-sm">
              {t('failedSearch')}
            </p>
          ) : null}
          {q.length >= 2 && customers.isSuccess && rows.length === 0 ? (
            <p role="status" className="text-muted-foreground text-sm">
              {t('noResults')}
            </p>
          ) : null}
          {q.length >= 2 && rows.length > 0 ? (
            <ul
              className="flex max-h-56 flex-col gap-1 overflow-y-auto"
              aria-label={t('searchLabel')}
            >
              {rows.map(row => {
                const name = customerListLabel(row) ?? t('unnamed')
                return (
                  <li key={row.id}>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-auto w-full justify-start py-2 text-left"
                      aria-label={t('pick', { name })}
                      onClick={() => onChoose(row.id)}
                    >
                      <span className="flex flex-col items-start">
                        <span>{name}</span>
                        <span className="text-muted-foreground text-xs">
                          {[row.email, row.phone].filter(Boolean).join(' · ')}
                        </span>
                      </span>
                    </Button>
                  </li>
                )
              })}
            </ul>
          ) : null}
        </>
      ) : (
        <p id="order-customer-search" role="status" className="text-muted-foreground text-sm">
          {t('needsPermission')}
        </p>
      )}
      {mayCreate ? (
        <Button type="button" variant="outline" size="sm" className="self-start" onClick={onNew}>
          {t('new')}
        </Button>
      ) : null}
    </div>
  )
}

function NewCustomer({
  onCancel,
  onCreated
}: {
  onCancel: () => void
  onCreated: (customer: CreatedCustomerView) => void
}): ReactElement {
  const t = useTranslations('orders.create.customer')
  const { storeId } = useStore()
  const create = useCreateCustomer(storeId)
  const guard = useSubmitGuard()
  const [values, setValues] = useState({ name: '', email: '', phone: '' })
  const [isEmpty, setEmpty] = useState(false)

  const submit = (): void => {
    const body = newCustomerBody(values)
    if (body === null) return setEmpty(true)
    if (!guard.enter()) return
    create.mutate(body, { onSuccess: onCreated, onSettled: guard.leave })
  }
  const set = (key: keyof typeof values, value: string): void => {
    setValues(current => ({ ...current, [key]: value }))
    setEmpty(false)
    create.reset()
  }

  return (
    // Not a <form>: Enter in a field must not save a customer the agent is still typing
    <fieldset className="flex flex-col gap-2 rounded-md border p-3">
      <legend className="px-1 text-sm font-medium">{t('new')}</legend>
      <div className="flex flex-col gap-1">
        <Label htmlFor="order-new-customer-name">{t('newName')}</Label>
        <Input
          id="order-new-customer-name"
          autoComplete="off"
          maxLength={CustomerLimits.NAME_MAX_LENGTH}
          value={values.name}
          onChange={event => set('name', event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="order-new-customer-email">{t('newEmail')}</Label>
        <Input
          id="order-new-customer-email"
          type="email"
          autoComplete="off"
          value={values.email}
          onChange={event => set('email', event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="order-new-customer-phone">{t('newPhone')}</Label>
        <Input
          id="order-new-customer-phone"
          type="tel"
          autoComplete="off"
          value={values.phone}
          onChange={event => set('phone', event.target.value)}
        />
      </div>
      <p
        className={isEmpty ? 'text-destructive text-sm' : 'text-muted-foreground text-xs'}
        role={isEmpty ? 'alert' : undefined}
      >
        {t('newHelp')}
      </p>
      <MutationError error={create.error} />
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          busy={create.isPending}
          disabled={create.isPending}
          onClick={submit}
        >
          {t('save')}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={create.isPending}
          onClick={onCancel}
        >
          {t('cancelNew')}
        </Button>
      </div>
    </fieldset>
  )
}
