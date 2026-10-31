'use client'

import { Search } from 'lucide-react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { AppPaths } from '@platform/api-client'
import { Permissions } from '@platform/core/auth'

import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'

// The actions an agent reaches for from the inbox (TDD_09 §8). Create order joins with Step 4.4 and
// View analytics with Step 5.2, which build the pages they open. Each action is offered to who may use it.
export function QuickActionsWidget(): ReactElement {
  const t = useTranslations('inbox.sidebar.quick')
  const { storeId, can } = useStore()
  const mayFind = can(Permissions.CUSTOMERS_VIEW)
  if (!mayFind) return <p className="text-muted-foreground text-sm">{t('none')}</p>
  return (
    <div className="flex flex-wrap gap-2">
      {/* The customers page puts the cursor in its search */}
      <Button asChild size="sm" variant="outline">
        <Link href={AppPaths.store.customers(storeId)}>
          <Search />
          {t('findCustomer')}
        </Link>
      </Button>
    </div>
  )
}
