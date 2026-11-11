'use client'

import { ExternalLink, Paperclip } from 'lucide-react'
import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { ClientPermissions } from '@platform/core/auth'

import { useMediaUrls } from '../../lib/media/use-media-urls'
import { useStore } from '../providers/store-context'

// The link of a file of an order (a receipt, a proof of delivery): signed, short lived, asked when the line is drawn and never
// stored. Only a member who may view files asks for it; the others see that there is a file.
export function OrderFileLink({ mediaId }: { mediaId: string }): ReactElement {
  const t = useTranslations('orders.detail.file')
  const { storeId, can } = useStore()
  const mayView = can(ClientPermissions.MEDIA_VIEW)
  const urls = useMediaUrls(storeId, mediaId, mayView)
  if (!mayView) return <span>{t('onFile')}</span>
  if (urls.data === undefined) {
    return <span>{urls.isError ? t('unavailable') : t('loading')}</span>
  }
  return (
    <a
      href={urls.data.url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 underline-offset-2 hover:underline"
    >
      <Paperclip aria-hidden className="size-4" />
      {urls.data.filename}
      <ExternalLink aria-hidden className="size-3.5" />
      <span className="sr-only">{t('opensInNewTab')}</span>
    </a>
  )
}
