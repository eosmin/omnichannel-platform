'use client'

import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { Permissions } from '@platform/core/auth'

import { useCustomer } from '../../lib/customers/use-customer-data'
import { useConversation } from '../../lib/inbox/use-inbox-data'
import { CustomerDetails } from '../customers/customer-details'
import { useCustomerDrawer } from '../customers/customer-drawer-context'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'

// The customer of the open conversation, on top of the right column of the inbox (TDD_09 §6): the
// identity side of the profile and a button to open the whole of it. Drawn only with CUSTOMERS_VIEW.
export function CustomerPanel({ conversationId }: { conversationId: string }): ReactElement | null {
  const t = useTranslations('customers.panel')
  const tAll = useTranslations()
  const { storeId, can } = useStore()
  const { openCustomer } = useCustomerDrawer()
  const conversation = useConversation(storeId, conversationId)
  const customerId = conversation.data?.customer.id ?? null
  const mayView = can(Permissions.CUSTOMERS_VIEW)
  const customer = useCustomer(storeId, mayView ? customerId : null)
  if (!mayView || conversation.data === undefined) return null

  return (
    <section aria-labelledby="sidebar-customer" className="flex flex-col gap-3">
      <h2
        id="sidebar-customer"
        className="text-muted-foreground text-xs font-semibold tracking-wide uppercase"
      >
        {t('title')}
      </h2>
      {customer.isError && customer.data === undefined ? (
        <div role="alert" className="flex flex-col items-start gap-2 text-sm">
          <p>{t('failed')}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => void customer.refetch()}>
            {tAll('common.tryAgain')}
          </Button>
        </div>
      ) : customer.data === undefined ? (
        <p role="status" className="text-muted-foreground text-sm">
          {tAll('common.loading')}
        </p>
      ) : (
        <>
          <CustomerDetails customer={customer.data} />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => openCustomer(customer.data.id)}
          >
            {t('openProfile')}
          </Button>
        </>
      )}
    </section>
  )
}
