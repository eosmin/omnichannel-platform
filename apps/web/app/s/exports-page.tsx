'use client'

import { Download } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import { type ExportView, fetchExportDownload } from '@platform/api-client'
import { ExportStatus } from '@platform/core/exports'

import { useStore } from '../../components/providers/store-context'
import { Button } from '../../components/ui/button'
import { apiClient } from '../../lib/api'
import { errorCodeOf, knownErrorCode } from '../../lib/error-message'
import {
  exportStatusKey,
  exportTypeKey,
  isExportReady,
  mayOpenExports
} from '../../lib/exports/export-state'
import { useExportList } from '../../lib/exports/use-export-data'

function Row({ item }: { item: ExportView }): ReactElement {
  const t = useTranslations('exports')
  const tErrors = useTranslations('errors')
  const format = useFormatter()
  const { storeId } = useStore()
  const [isAsking, setIsAsking] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  // The link is signed, lasts minutes and answers with `Content-Disposition: attachment`: the page
  // goes to it in the same tab, which downloads the file and leaves the page where it is
  const download = async (): Promise<void> => {
    setIsAsking(true)
    setFailure(null)
    try {
      const link = await fetchExportDownload(apiClient, storeId, item.id)
      window.location.assign(link.url)
    } catch (error) {
      setFailure(tErrors(errorCodeOf(error)))
    } finally {
      setIsAsking(false)
    }
  }

  const statusKey = exportStatusKey(item.status)
  return (
    <tr className="border-b align-top">
      <td className="py-2 pr-3 text-sm font-medium">{t(`types.${exportTypeKey(item.type)}`)}</td>
      <td className="py-2 pr-3 text-sm">
        <span>{t(`statuses.${statusKey}`)}</span>
        {item.status === ExportStatus.FAILED && item.error !== null ? (
          <p className="text-destructive text-xs">{tErrors(knownErrorCode(item.error))}</p>
        ) : null}
      </td>
      <td className="text-muted-foreground py-2 pr-3 text-sm break-all">{item.filename ?? '-'}</td>
      <td className="text-muted-foreground py-2 pr-3 text-sm">
        {item.rowCount === null ? '-' : format.number(item.rowCount)}
      </td>
      <td className="text-muted-foreground py-2 pr-3 text-sm">
        {format.dateTime(new Date(item.createdAt), { dateStyle: 'medium', timeStyle: 'short' })}
      </td>
      <td className="text-muted-foreground py-2 pr-3 text-sm">
        {isExportReady(item)
          ? format.dateTime(new Date(item.expiresAt), { dateStyle: 'medium' })
          : '-'}
      </td>
      <td className="py-2">
        {isExportReady(item) ? (
          <Button
            size="sm"
            variant="outline"
            disabled={isAsking}
            aria-label={t('downloadFile', {
              name: item.filename ?? t(`types.${exportTypeKey(item.type)}`)
            })}
            onClick={() => void download()}
          >
            <Download aria-hidden />
            {t('download')}
          </Button>
        ) : null}
        {failure === null ? null : (
          <p role="alert" className="text-destructive mt-1 text-xs">
            {failure}
          </p>
        )}
      </td>
    </tr>
  )
}

// The exports center: the files this member asked for, newest first. The api narrows the list; the
// page only needs one of the export permissions to ask.
export function ExportsPage(): ReactElement {
  const t = useTranslations('exports')
  const tCommon = useTranslations('common')
  const { storeId, can } = useStore()
  const mayAsk = mayOpenExports(can)
  const exports = useExportList(storeId, mayAsk)
  const rows = exports.data?.pages.flatMap(page => page.data) ?? []

  if (!mayAsk) {
    return (
      <p role="alert" className="text-sm">
        {t('noAccess')}
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">{t('title')}</h1>
      <p className="text-muted-foreground text-sm">{t('intro')}</p>
      {exports.isPending ? (
        <p role="status" className="text-muted-foreground text-sm">
          {tCommon('loading')}
        </p>
      ) : null}
      {exports.isError && rows.length === 0 ? (
        <div role="alert" className="flex flex-col items-start gap-2 text-sm">
          <p>{t('failed')}</p>
          <Button variant="outline" size="sm" onClick={() => void exports.refetch()}>
            {tCommon('tryAgain')}
          </Button>
        </div>
      ) : null}
      {exports.isSuccess && rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('empty')}</p>
      ) : null}
      {rows.length === 0 ? null : (
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <caption className="sr-only">{t('title')}</caption>
            <thead>
              <tr className="text-muted-foreground border-b text-xs uppercase">
                {(['type', 'status', 'file', 'rows', 'created', 'expires'] as const).map(column => (
                  <th key={column} scope="col" className="py-2 pr-3 font-semibold">
                    {t(`columns.${column}`)}
                  </th>
                ))}
                <th scope="col" className="py-2 font-semibold">
                  <span className="sr-only">{t('columns.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map(item => (
                <Row key={item.id} item={item} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {exports.isRefetchError && rows.length > 0 ? (
        <p role="alert" className="text-muted-foreground text-sm">
          {t('stale')}
        </p>
      ) : null}
      {exports.isFetchNextPageError ? (
        <p role="alert" className="text-destructive text-sm">
          {t('failed')}
        </p>
      ) : null}
      {exports.hasNextPage ? (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          disabled={exports.isFetchingNextPage}
          onClick={() => void exports.fetchNextPage()}
        >
          {t('loadMore')}
        </Button>
      ) : null}
    </div>
  )
}
