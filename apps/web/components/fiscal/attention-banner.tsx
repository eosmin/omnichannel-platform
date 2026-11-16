'use client'

import { TriangleAlert } from 'lucide-react'
import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { FiscalDocumentStatus } from '@platform/core/domain'

import { FiscalAttention, fiscalAttentionOf } from '../../lib/fiscal/document-rules'
import { useFiscalDocuments } from '../../lib/fiscal/use-fiscal'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'

// The notice that a document was refused or is stuck in the queue (TDD_18 §8.3): asked of the api on its own, so it is right whatever the
// list below is filtered by. It counts the newest page of each (the api filters by status, not by attempts), and says "more than" when
// there is another page.
export function AttentionBanner({
  onShowRejected
}: {
  onShowRejected: () => void
}): ReactElement | null {
  const t = useTranslations('finance.fiscal.banner')
  const { storeId } = useStore()
  const rejected = useFiscalDocuments(storeId, { status: FiscalDocumentStatus.REJECTED }, true)
  const queued = useFiscalDocuments(storeId, { status: FiscalDocumentStatus.QUEUED }, true)
  const rejectedPage = rejected.data?.pages[0]
  const queuedPage = queued.data?.pages[0]
  const refused = rejectedPage?.data.length ?? 0
  const stuck =
    queuedPage?.data.filter(document => fiscalAttentionOf(document) === FiscalAttention.STUCK)
      .length ?? 0
  if (refused === 0 && stuck === 0) return null
  return (
    <div
      role="status"
      data-testid="fiscal-banner"
      className="border-destructive/40 bg-destructive/5 flex flex-col gap-2 rounded-md border p-3 text-sm sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex items-start gap-2">
        <TriangleAlert aria-hidden className="text-destructive mt-0.5 size-4 shrink-0" />
        <div className="flex flex-col gap-0.5">
          {refused === 0 ? null : (
            <p data-testid="fiscal-banner-rejected">
              {t(rejectedPage?.hasMore === true ? 'rejectedMore' : 'rejected', { count: refused })}
            </p>
          )}
          {stuck === 0 ? null : (
            <p data-testid="fiscal-banner-stuck">
              {t(queuedPage?.hasMore === true ? 'stuckMore' : 'stuck', { count: stuck })}
            </p>
          )}
        </div>
      </div>
      {refused === 0 ? null : (
        <Button variant="outline" size="sm" onClick={onShowRejected}>
          {t('show')}
        </Button>
      )}
    </div>
  )
}
