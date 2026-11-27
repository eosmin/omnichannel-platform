'use client'

import { Download } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type ReactElement, useEffect } from 'react'

import { ApiError, type FiscalDocumentView } from '@platform/api-client'
import { FiscalDocumentStatus, type FiscalEvidenceKind } from '@platform/core/domain'
import { HttpStatusCodes } from '@platform/core/errors'

import { fiscalEvidenceKindsOf } from '../../lib/fiscal/document-rules'
import { useFiscalDelivery, useFiscalEvidenceLink } from '../../lib/fiscal/use-fiscal'
import { useFiscalErrorText } from '../../lib/fiscal/use-fiscal-error-text'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'

import { HandDelivery } from './hand-delivery'

// The api signs a link for 15 minutes: it is shown for 10
const EVIDENCE_LINK_SHOWN_MS = 10 * 60 * 1000

// The files of evidence of a document (TDD_18 §8.3): what was built, what the authority answered to the acceptance and to the invalidation.
// The system makes them; a person only reads them, so there is no upload here. A link is asked when the person asks for the file: the api
// signs it for 15 minutes, only for a clean file of the organization of the document, and writes the read in the audit log. The files hold
// the receiver's data, so a link is never kept or shown twice.
export function EvidencePanel({
  document,
  canManage
}: {
  document: FiscalDocumentView
  canManage: boolean
}): ReactElement | null {
  const t = useTranslations('finance.fiscal.evidence')
  const { storeId } = useStore()
  // Which files exist is the api's to say: a voided document never made the two files of the receiver if it was voided before they were
  // (they are made while it is accepted), and a button for a file that does not exist only leads to a 404
  const accepted = document.status === FiscalDocumentStatus.ACCEPTED
  const delivery = useFiscalDelivery(
    storeId,
    document.id,
    accepted || document.status === FiscalDocumentStatus.VOIDED
  )
  const kinds = fiscalEvidenceKindsOf(document, delivery.data?.files ?? [])
  if (kinds.length === 0) return null
  return (
    <>
      <section
        className="flex flex-col gap-2"
        aria-label={t('title')}
        data-testid="fiscal-evidence"
      >
        <h3 className="text-sm font-semibold">{t('title')}</h3>
        <p className="text-muted-foreground text-xs">{t('description')}</p>
        <ul className="flex flex-col gap-2">
          {kinds.map(kind => (
            <EvidenceRow key={`${document.id}:${kind}`} documentId={document.id} kind={kind} />
          ))}
        </ul>
      </section>
      {accepted && delivery.data !== undefined ? (
        <HandDelivery document={document} delivery={delivery.data} canManage={canManage} />
      ) : null}
    </>
  )
}

function EvidenceRow({
  documentId,
  kind
}: {
  documentId: string
  kind: FiscalEvidenceKind
}): ReactElement {
  const t = useTranslations('finance.fiscal.evidence')
  const errorText = useFiscalErrorText()
  const { storeId } = useStore()
  const link = useFiscalEvidenceLink(storeId)
  // A link is cleared before it expires, so an expired one is never left to click and one is not kept in the page for long
  const { data, reset } = link
  useEffect(() => {
    if (data === undefined) return undefined
    const timer = setTimeout(reset, EVIDENCE_LINK_SHOWN_MS)
    return () => clearTimeout(timer)
  }, [data, reset])
  // The api answers 404 while the file is not there yet (it is made after the decision and scanned): that is a wait, not a fault
  const missing = link.error instanceof ApiError && link.error.status === HttpStatusCodes.NOT_FOUND
  return (
    <li
      className="flex flex-col gap-1 rounded-md border p-2 text-sm sm:flex-row sm:items-center sm:justify-between"
      data-testid={`fiscal-evidence-${kind}`}
    >
      <div className="flex min-w-0 flex-col">
        <span className="font-medium">{t(`kinds.${kind}.label`)}</span>
        <span className="text-muted-foreground text-xs">{t(`kinds.${kind}.hint`)}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {link.data === undefined ? null : (
          <a
            href={link.data.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary text-sm break-all underline underline-offset-2"
            data-testid={`fiscal-evidence-${kind}-link`}
          >
            {t('open', { name: link.data.filename })}
          </a>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={link.isPending}
          busy={link.isPending}
          onClick={() => link.mutate({ id: documentId, kind })}
        >
          <Download className="size-4" aria-hidden="true" />
          {link.data === undefined ? t('get') : t('getAgain')}
        </Button>
      </div>
      {link.isError ? (
        <p role="alert" className="text-destructive text-xs sm:basis-full">
          {missing ? t('missing') : errorText(link.error)}
        </p>
      ) : null}
    </li>
  )
}
