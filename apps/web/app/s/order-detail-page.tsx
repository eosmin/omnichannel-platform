'use client'

import { ArrowLeft } from 'lucide-react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { AppPaths } from '@platform/api-client'

import { useStore } from '../../components/providers/store-context'

// The page an order number of the list opens. Step 4.4 PR A2 builds the detail (lines, allocations, status flows, edits)
// in this file; until then it only gives the way back, so a link of the list never ends in a 404.
export function OrderDetailPage(): ReactElement {
  const t = useTranslations('orders.detail')
  const { storeId } = useStore()
  return (
    <div className="flex flex-col gap-3">
      <Link
        href={AppPaths.store.orders(storeId)}
        className="inline-flex items-center gap-1 self-start text-sm underline-offset-2 hover:underline"
      >
        <ArrowLeft aria-hidden className="size-4" />
        {t('back')}
      </Link>
      <h1 className="text-xl font-semibold">{t('title')}</h1>
    </div>
  )
}
