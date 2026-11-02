'use client'

import { useQuery } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { fetchChannelTemplates, QueryKeys } from '@platform/api-client'
import { TemplateStatuses } from '@platform/core/domain'

import { apiClient } from '../../lib/api'
import { useStore } from '../providers/store-context'

import { LoadFailed, PageLoading } from './states'

// The templates of one account with where each stands with the provider (TDD_10 §10). Read from the
// same route and key as the composer's picker, so opening one warms the other.
export function TemplatesList({
  pluginId,
  connectionId
}: {
  pluginId: string
  connectionId: string
}): ReactElement {
  const t = useTranslations('settings.channels.templates')
  const { storeId } = useStore()
  const templates = useQuery({
    queryKey: QueryKeys.channels.templates(storeId, pluginId, connectionId),
    queryFn: ({ signal }) =>
      fetchChannelTemplates(apiClient, storeId, pluginId, connectionId, signal)
  })
  if (templates.isError) {
    return <LoadFailed error={templates.error} onRetry={() => void templates.refetch()} />
  }
  if (templates.data === undefined) return <PageLoading />
  if (templates.data.length === 0) {
    return <p className="text-muted-foreground text-sm">{t('empty')}</p>
  }
  const statusText = (status: string): string =>
    status === TemplateStatuses.APPROVED
      ? t('status.approved')
      : status === TemplateStatuses.PENDING
        ? t('status.pending')
        : status === TemplateStatuses.REJECTED
          ? t('status.rejected')
          : status
  return (
    <ul className="divide-y rounded-md border">
      {templates.data.map(template => (
        <li
          key={`${template.name}/${template.language}`}
          className="flex flex-col gap-1 p-3 text-sm"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium">
              {template.name} <span className="text-muted-foreground">({template.language})</span>
            </span>
            <span className="text-muted-foreground text-xs">{statusText(template.status)}</span>
          </div>
          <p className="text-muted-foreground text-xs whitespace-pre-wrap">{template.body}</p>
        </li>
      ))}
    </ul>
  )
}
