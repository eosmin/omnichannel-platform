'use client'

import { Download, Search } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useFormatter, useTranslations } from 'next-intl'
import { type ReactElement, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import { AppPaths, type CustomerListItemView } from '@platform/api-client'
import { Permissions } from '@platform/core/auth'
import { CustomerLimits } from '@platform/core/domain'

import { useCustomerDrawer } from '../../components/customers/customer-drawer-context'
import { MutationError } from '../../components/customers/mutation-error'
import { useStore } from '../../components/providers/store-context'
import { ShortcutsProvider } from '../../components/shortcuts/shortcuts-provider'
import { useGoToShortcuts } from '../../components/shortcuts/use-go-to'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { customerListLabel } from '../../lib/customers/customer-name'
import { tagDotColor } from '../../lib/customers/tag-color'
import { useCustomerList } from '../../lib/customers/use-customer-data'
import { useExportCustomers } from '../../lib/customers/use-customer-export'
import { useChannelName } from '../../lib/inbox/use-inbox-data'
import { useDebouncedValue } from '../../lib/use-debounced-value'

const SEARCH_DELAY_MS = 300

function ChannelLabel({ channelType }: { channelType: string }): ReactElement {
  const { storeId } = useStore()
  return <>{useChannelName(storeId, channelType)}</>
}

function Row({ customer }: { customer: CustomerListItemView }): ReactElement {
  const t = useTranslations('customers.list')
  const format = useFormatter()
  const { openCustomer } = useCustomerDrawer()
  const label = customerListLabel(customer)
  const contact = [customer.email, customer.phone].filter(
    (value): value is string => value !== null && value !== label
  )
  const since = new Date(customer.createdAt)
  return (
    <tr className="border-b align-top">
      <td className="py-2 pr-3">
        <Button
          variant="ghost"
          className="h-auto max-w-full justify-start px-1 py-0.5 font-medium"
          onClick={() => openCustomer(customer.id)}
        >
          <span className="truncate">{label ?? t('unnamed')}</span>
        </Button>
        {customer.isCaution ? (
          <span className="text-muted-foreground ml-1 text-xs">{t('caution')}</span>
        ) : null}
      </td>
      <td className="text-muted-foreground py-2 pr-3 text-sm break-all">
        {contact.map(line => (
          <p key={line}>{line}</p>
        ))}
      </td>
      <td className="py-2 pr-3 text-sm">
        {customer.channels.map((channelType, index) => (
          <span key={channelType}>
            {index === 0 ? '' : ', '}
            <ChannelLabel channelType={channelType} />
          </span>
        ))}
      </td>
      <td className="py-2 pr-3 text-sm">
        <ul className="flex flex-wrap gap-x-3 gap-y-1">
          {customer.tags.map(tag => (
            <li key={tag.id} className="flex items-center gap-1">
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: tagDotColor(tag.color) }}
              />
              {tag.name}
            </li>
          ))}
        </ul>
      </td>
      <td className="text-muted-foreground py-2 text-sm whitespace-nowrap">
        {Number.isNaN(since.getTime()) ? '' : format.dateTime(since, { dateStyle: 'medium' })}
      </td>
    </tr>
  )
}

// The customers of the store (TDD_09 §6): a table with the search the api takes, a page at a time,
// each customer opening the profile drawer. The export joins in Step 3.4, which builds the center it
// belongs to; until then the button is there, turned off.
export function CustomersPage(): ReactElement {
  return (
    <ShortcutsProvider>
      <Page />
    </ShortcutsProvider>
  )
}

function Page(): ReactElement {
  const t = useTranslations('customers.list')
  const tAll = useTranslations()
  const { storeId, can } = useStore()
  useGoToShortcuts()
  const searchRef = useRef<HTMLInputElement>(null)
  const [text, setText] = useState('')
  const q = useDebouncedValue(text.trim(), SEARCH_DELAY_MS)
  const customers = useCustomerList(storeId, q, can(Permissions.CUSTOMERS_VIEW))
  const router = useRouter()
  const exportCsv = useExportCustomers(storeId)
  const rows = customers.data?.pages.flatMap(page => page.data) ?? []

  // The search is where the hand goes first, and the Find customer action of the inbox lands here
  useEffect(() => {
    searchRef.current?.focus()
  }, [])

  if (!can(Permissions.CUSTOMERS_VIEW)) {
    return (
      <div className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        <p role="alert" className="text-sm">
          {t('noAccess')}
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="flex-1 text-xl font-semibold">{t('title')}</h1>
        {can(Permissions.CUSTOMERS_EXPORT) ? (
          <Button
            variant="outline"
            size="sm"
            disabled={exportCsv.isPending}
            onClick={() => {
              // What the input shows, not the debounced search; mutateAsync so the toast also
              // appears when the person has already left the page
              exportCsv
                .mutateAsync(text.trim())
                .then(() =>
                  toast.success(t('exportQueued'), {
                    action: {
                      label: t('viewExports'),
                      onClick: () => router.push(AppPaths.store.exports(storeId))
                    }
                  })
                )
                .catch(() => undefined) // the error is drawn by MutationError
            }}
          >
            <Download />
            {t('export')}
          </Button>
        ) : null}
      </div>
      <MutationError error={exportCsv.error} />
      <div className="relative max-w-md">
        <Search
          aria-hidden
          className="text-muted-foreground pointer-events-none absolute top-2.5 left-2.5 size-4"
        />
        <Input
          ref={searchRef}
          type="search"
          className="pl-8"
          aria-label={t('searchLabel')}
          placeholder={t('searchPlaceholder')}
          maxLength={CustomerLimits.SEARCH_MAX_LENGTH}
          value={text}
          onChange={event => setText(event.target.value)}
        />
      </div>

      {customers.isPending ? (
        <p role="status" className="text-muted-foreground text-sm">
          {tAll('common.loading')}
        </p>
      ) : null}
      {customers.isError && rows.length === 0 ? (
        <div role="alert" className="flex flex-col items-start gap-2 text-sm">
          <p>{t('failed')}</p>
          <Button variant="outline" size="sm" onClick={() => void customers.refetch()}>
            {tAll('common.tryAgain')}
          </Button>
        </div>
      ) : null}
      {customers.isSuccess && rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">{q === '' ? t('empty') : t('noMatches')}</p>
      ) : null}

      {rows.length === 0 ? null : (
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <caption className="sr-only">{t('title')}</caption>
            <thead>
              <tr className="text-muted-foreground border-b text-xs uppercase">
                <th scope="col" className="py-2 pr-3 font-semibold">
                  {t('columns.name')}
                </th>
                <th scope="col" className="py-2 pr-3 font-semibold">
                  {t('columns.contact')}
                </th>
                <th scope="col" className="py-2 pr-3 font-semibold">
                  {t('columns.channels')}
                </th>
                <th scope="col" className="py-2 pr-3 font-semibold">
                  {t('columns.tags')}
                </th>
                <th scope="col" className="py-2 font-semibold">
                  {t('columns.since')}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map(customer => (
                <Row key={customer.id} customer={customer} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {customers.isFetchNextPageError ? (
        <p role="alert" className="text-destructive text-sm">
          {t('failed')}
        </p>
      ) : null}
      {customers.hasNextPage ? (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          disabled={customers.isFetchingNextPage}
          onClick={() => void customers.fetchNextPage()}
        >
          {t('loadMore')}
        </Button>
      ) : null}
    </div>
  )
}
