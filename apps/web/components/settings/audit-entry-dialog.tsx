'use client'

import { useFormatter, useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { metadataText } from '../../lib/settings/audit-log-filter'
import { useAuditLogEntry } from '../../lib/settings/use-audit-log'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'

import { LoadFailed } from './states'

// One entry of the audit log in full: the instant, the actor, the action, what it acted on, where it came from and the
// metadata the writer kept (ids and counts). Everything is drawn as text. Opening it is audited by the api.
export function AuditEntryDialog({
  id,
  actorName,
  onClose
}: {
  id: string
  actorName: (userId: string | null) => string
  onClose: () => void
}): ReactElement {
  const t = useTranslations('settings.auditLog.entry')
  const tCommon = useTranslations('common')
  const format = useFormatter()
  const { storeId } = useStore()
  const entry = useAuditLogEntry(storeId, id)
  const none = t('none')
  const metadata = entry.data === undefined ? '' : metadataText(entry.data.metadata)
  const fields =
    entry.data === undefined
      ? []
      : [
          [
            t('when'),
            format.dateTime(new Date(entry.data.timestamp), {
              dateStyle: 'long',
              timeStyle: 'medium'
            })
          ],
          [t('actor'), actorName(entry.data.userId)],
          [t('action'), entry.data.action],
          [t('resourceType'), entry.data.resourceType ?? none],
          [t('resourceId'), entry.data.resourceId ?? none],
          [t('ip'), entry.data.ipAddress ?? none],
          [t('userAgent'), entry.data.userAgent ?? none],
          [t('id'), entry.data.id]
        ]

  return (
    <Dialog open onOpenChange={open => (open ? undefined : onClose())}>
      <DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        {entry.isError ? (
          <LoadFailed error={entry.error} onRetry={() => void entry.refetch()} />
        ) : entry.data === undefined ? (
          <p role="status" className="text-muted-foreground py-6 text-center text-sm">
            {tCommon('loading')}
          </p>
        ) : (
          <>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm">
              {fields.map(([label, value]) => (
                <div key={label} className="contents">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="[overflow-wrap:anywhere]">{value}</dd>
                </div>
              ))}
            </dl>
            <div className="flex flex-col gap-1">
              <h3 className="text-sm font-medium">{t('metadata')}</h3>
              {metadata === '' ? (
                <p className="text-muted-foreground text-sm">{t('noMetadata')}</p>
              ) : (
                <pre
                  tabIndex={0}
                  aria-label={t('metadata')}
                  className="bg-muted max-h-64 overflow-auto rounded-md p-3 text-xs"
                >
                  {metadata}
                </pre>
              )}
            </div>
          </>
        )}
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            {tCommon('close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
