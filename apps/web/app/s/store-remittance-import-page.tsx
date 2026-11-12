'use client'

import { ArrowLeft } from 'lucide-react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { AppPaths } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'

import { useStore } from '../../components/providers/store-context'
import { PermissionDenied } from '../../components/settings/states'

import { LazyImportMapper } from './lazy-remittances'

// Import the settlement file of a carrier (TDD_17 §4.15): the mapper, the preview and the draft it makes. Reading profiles asks
// for remittances:view, and the preview and the import ask for remittances:manage, which the page needs as a whole.
export function StoreRemittanceImportPage(): ReactElement {
  const t = useTranslations('remittances.import')
  const { storeId, can } = useStore()
  if (!can(ClientPermissions.REMITTANCES_MANAGE)) {
    return <PermissionDenied permission={ClientPermissions.REMITTANCES_MANAGE} />
  }
  return (
    <div className="flex max-w-4xl flex-col gap-5">
      <Link
        href={AppPaths.store.remittances(storeId)}
        className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-sm pointer-coarse:min-h-10"
      >
        <ArrowLeft aria-hidden className="size-4" />
        {t('back')}
      </Link>
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('description')}</p>
      </header>
      <LazyImportMapper />
    </div>
  )
}
