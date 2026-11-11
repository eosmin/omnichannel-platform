'use client'

import { Search, ShoppingBag } from 'lucide-react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { AppPaths } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'

import { askSearchFocus } from '../../lib/customers/search-focus'
import { useConversation } from '../../lib/inbox/use-inbox-data'
import { useOrderDrawer } from '../orders/order-drawer-context'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'

// With a conversation open the order is made for its customer and linked to it; without one the drawer asks for the
// customer. The button waits for the conversation to load: until then it is not known whose order it would be.
function CreateOrderButton(): ReactElement {
  const t = useTranslations('inbox.sidebar.quick')
  const { openCreate } = useOrderDrawer()
  return (
    <Button type="button" size="sm" variant="outline" onClick={() => openCreate()}>
      <ShoppingBag />
      {t('createOrder')}
    </Button>
  )
}

function CreateOrderForConversation({ conversationId }: { conversationId: string }): ReactElement {
  const t = useTranslations('inbox.sidebar.quick')
  const { storeId } = useStore()
  const { openCreate } = useOrderDrawer()
  const conversation = useConversation(storeId, conversationId)
  const customerId = conversation.data?.customer.id
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={customerId === undefined}
      onClick={() => {
        if (customerId !== undefined) openCreate({ customerId, conversationId })
      }}
    >
      <ShoppingBag />
      {t('createOrder')}
    </Button>
  )
}

// The actions an agent reaches for from the inbox (TDD_09 §8). View analytics joins with Step 5.2, which builds the
// page it opens. Each action is offered to who may use it.
export function QuickActionsWidget(): ReactElement {
  const t = useTranslations('inbox.sidebar.quick')
  const { storeId, can } = useStore()
  const { conversationId } = useParams<{ conversationId?: string }>()
  const mayFind = can(ClientPermissions.CUSTOMERS_VIEW)
  const mayCreateOrder = can(ClientPermissions.ORDERS_CREATE)
  if (!mayFind && !mayCreateOrder) {
    return <p className="text-muted-foreground text-sm">{t('none')}</p>
  }
  return (
    <div className="flex flex-wrap gap-2">
      {mayCreateOrder ? (
        conversationId === undefined ? (
          <CreateOrderButton />
        ) : (
          <CreateOrderForConversation conversationId={conversationId} />
        )
      ) : null}
      {/* Asks the customers page to put the cursor in its search */}
      {mayFind ? (
        <Button asChild size="sm" variant="outline">
          <Link href={AppPaths.store.customers(storeId)} onClick={askSearchFocus}>
            <Search />
            {t('findCustomer')}
          </Link>
        </Button>
      ) : null}
    </div>
  )
}
