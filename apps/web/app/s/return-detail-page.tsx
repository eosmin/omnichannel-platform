'use client'

import { ArrowLeft } from 'lucide-react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { ApiError, AppPaths } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'
import { HttpStatusCodes } from '@platform/core/errors'

import { useStore } from '../../components/providers/store-context'
import { ReturnDetail } from '../../components/returns/return-detail'
import { LoadFailed, PageLoading, PermissionDenied } from '../../components/settings/states'
import { useReturn } from '../../lib/returns/use-returns'

function BackLink(): ReactElement {
  const t = useTranslations('returns.detail')
  const { storeId } = useStore()
  return (
    <Link
      href={AppPaths.store.returns(storeId)}
      className="inline-flex items-center gap-1 self-start text-sm underline-offset-2 hover:underline"
    >
      <ArrowLeft aria-hidden className="size-4" />
      {t('back')}
    </Link>
  )
}

// One return (TDD_17 §4.11). Opening asks for returns:view; its moves ask for returns:manage.
export function ReturnDetailPage(): ReactElement {
  const t = useTranslations('returns.detail')
  const { storeId, can } = useStore()
  const { returnId = '' } = useParams<{ returnId?: string }>()
  const canView = can(ClientPermissions.RETURNS_VIEW)
  const query = useReturn(storeId, returnId, canView && returnId !== '')
  if (!canView) return <PermissionDenied permission={ClientPermissions.RETURNS_VIEW} />
  if (query.data !== undefined) {
    return (
      <div className="flex flex-col gap-4">
        <BackLink />
        <ReturnDetail entry={query.data} />
      </div>
    )
  }
  if (query.isError) {
    const missing =
      query.error instanceof ApiError && query.error.status === HttpStatusCodes.NOT_FOUND
    return (
      <div className="flex flex-col gap-3">
        <BackLink />
        {missing ? (
          <p role="alert" className="text-sm">
            {t('notFound')}
          </p>
        ) : (
          <LoadFailed error={query.error} onRetry={() => void query.refetch()} />
        )}
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-3">
      <BackLink />
      <PageLoading />
    </div>
  )
}
