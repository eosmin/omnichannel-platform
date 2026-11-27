'use client'

import { useFormatter, useTranslations } from 'next-intl'
import { type ReactElement, type ReactNode, useRef, useState } from 'react'

import {
  ApiError,
  type FiscalDocumentDetailView,
  type FiscalDocumentView,
  type FiscalProviderView
} from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'
import { FiscalDocumentKind } from '@platform/core/domain'

import { useMoney } from '../../lib/finance/use-money'
import {
  conflictReasonOf,
  coreRejectionOf,
  fiscalActionsOf,
  fiscalAttentionOf,
  isIssuerChangedInFlight
} from '../../lib/fiscal/document-rules'
import {
  useFiscalDocument,
  useReplaceFiscalDocument,
  useRetryFiscalDocument
} from '../../lib/fiscal/use-fiscal'
import { useFiscalErrorText } from '../../lib/fiscal/use-fiscal-error-text'
import { useSubmitGuard } from '../../lib/submit-guard'
import { toast } from '../../lib/toast'
import { OrderLink } from '../finance/order-link'
import { useStore } from '../providers/store-context'
import { LoadFailed, PageLoading } from '../settings/states'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  stickyDialogActionsClass
} from '../ui/dialog'

import { EvidencePanel } from './evidence-panel'
import { FiscalStatusBadge } from './fiscal-status-badge'
import { IssuerChangeDialog } from './issuer-change-dialog'
import { ReceiverDialog } from './receiver-dialog'
import { SealedDetail } from './sealed-detail'
import { VoidDialog } from './void-dialog'

// One fiscal document (TDD_18 §8.3). It is read only: after the authority accepts it nothing of it changes but its status, and the
// receiver is fixed only while it was refused or never sent. What the person may do is shown by the state of the document and by
// fiscal:manage; the api decides again on every call.
export function DocumentDetailDialog({
  documentId,
  providers,
  replacedIds,
  onOpenChange
}: {
  documentId: string | null
  providers: readonly FiscalProviderView[]
  replacedIds: ReadonlySet<string>
  onOpenChange: (open: boolean) => void
}): ReactElement {
  const { storeId } = useStore()
  // The last id is kept while the dialog closes, so the content does not flip to loading during the animation
  const lastId = useRef(documentId)
  if (documentId !== null) lastId.current = documentId
  const document = useFiscalDocument(storeId, documentId ?? lastId.current, documentId !== null)
  const t = useTranslations('finance.fiscal.detail')
  return (
    <Dialog open={documentId !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        {document.data === undefined ? (
          <>
            <DialogHeader>
              <DialogTitle>{t('titleLoading')}</DialogTitle>
              <DialogDescription>{t('loading')}</DialogDescription>
            </DialogHeader>
            {document.isError ? (
              <LoadFailed error={document.error} onRetry={() => void document.refetch()} />
            ) : (
              <PageLoading />
            )}
            <CloseFooter />
          </>
        ) : (
          <DocumentBody
            document={document.data}
            provider={providers.find(provider => provider.id === document.data.providerId)}
            replacedIds={replacedIds}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function DocumentBody({
  document,
  provider,
  replacedIds
}: {
  document: FiscalDocumentDetailView
  provider: FiscalProviderView | undefined
  replacedIds: ReadonlySet<string>
}): ReactElement {
  const t = useTranslations('finance.fiscal.detail')
  const tKind = useTranslations('finance.fiscal.kind')
  const format = useFormatter()
  const money = useMoney()
  const { can } = useStore()
  const [editingReceiver, setEditingReceiver] = useState(false)
  const [voiding, setVoiding] = useState(false)
  const [changingIssuer, setChangingIssuer] = useState(false)
  const actions = fiscalActionsOf(
    document,
    replacedIds,
    (provider?.manifest.voidInputs?.kindsWithReplacement?.length ?? 0) > 0
  )
  const canManage = can(ClientPermissions.FISCAL_MANAGE)
  const when = (iso: string | null): string =>
    iso === null
      ? t('never')
      : format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' })
  // The label of the type is the provider's own words (plain data in its manifest); until the document is built it has no type
  const typeLabel =
    provider?.manifest.documentTypes.find(type => type.id === document.documentType)?.label ?? null
  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex flex-wrap items-center gap-2">
          {t('title', { number: document.sequenceNumber })}
          <FiscalStatusBadge status={document.status} />
        </DialogTitle>
        <DialogDescription>{t('description')}</DialogDescription>
      </DialogHeader>
      <AttentionNotice document={document} />
      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2" data-testid="fiscal-detail">
        <Item label={t('kind')}>{tKind(document.kind)}</Item>
        <Item label={t('type')}>{typeLabel ?? t('typePending')}</Item>
        <Item label={t('externalNumber')}>{document.externalNumber ?? t('none')}</Item>
        <Item label={t('environment')}>{t(`environments.${document.environment}`)}</Item>
        <Item label={t('total')}>{money(document.totalCents)}</Item>
        <Item label={t('tax')}>{money(document.taxCents)}</Item>
        <Item label={t('createdAt')}>{when(document.createdAt)}</Item>
        <Item label={t('issuedAt')}>{when(document.issuedAt)}</Item>
        <Item label={t('attempts')}>{String(document.attempts)}</Item>
        <Item label={t('order')}>
          {/* Only for who may read the orders of the store of the document: the link of a person without them would end at "no access" */}
          <OrderLink storeId={document.storeId} orderId={document.orderId} fallback={t('none')}>
            {t('openOrder')}
          </OrderLink>
        </Item>
        {document.kind === FiscalDocumentKind.CREDIT_NOTE ? (
          <Item label={t('cancels')}>{t('cancelsDocument')}</Item>
        ) : null}
        {document.replacesDocumentId === null ? null : (
          <Item label={t('replaces')}>{t('replacesDocument')}</Item>
        )}
        {document.voidedAt === null ? null : (
          <Item label={t('voidedAt')}>{when(document.voidedAt)}</Item>
        )}
        {document.voidReason === null ? null : (
          <Item label={t('voidReason')}>{document.voidReason}</Item>
        )}
      </dl>
      <section className="flex flex-col gap-1" aria-label={t('receiver.title')}>
        <h3 className="text-sm font-semibold">{t('receiver.title')}</h3>
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2" data-testid="fiscal-receiver">
          <Item label={t('receiver.name')}>{document.receiver.name ?? t('none')}</Item>
          <Item label={t('receiver.taxId')}>{document.receiver.taxIdMasked ?? t('none')}</Item>
          <Item label={t('receiver.complete')}>
            {document.receiver.complete ? t('receiver.yes') : t('receiver.no')}
          </Item>
        </dl>
        <p className="text-muted-foreground text-xs">{t('receiver.minimized')}</p>
      </section>
      <SealedDetail detail={document.detail} />
      <EvidencePanel document={document} canManage={canManage} />
      <p className="text-muted-foreground text-xs">{t('immutable')}</p>
      {canManage ? (
        <Actions
          document={document}
          actions={actions}
          onEditReceiver={() => setEditingReceiver(true)}
          onVoid={() => setVoiding(true)}
          onConfirmIssuerChange={() => setChangingIssuer(true)}
        />
      ) : null}
      <ReceiverDialog
        document={document}
        provider={provider}
        open={editingReceiver}
        onOpenChange={setEditingReceiver}
      />
      <VoidDialog document={document} open={voiding} onOpenChange={setVoiding} />
      <IssuerChangeDialog
        document={document}
        open={changingIssuer}
        onOpenChange={setChangingIssuer}
      />
      <CloseFooter />
    </>
  )
}

function Item({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="break-words">{children}</dd>
    </div>
  )
}

// A refusal or a document that ran out of attempts: what happened, in words, and what to do
function AttentionNotice({ document }: { document: FiscalDocumentView }): ReactElement | null {
  const t = useTranslations('finance.fiscal.attention')
  const tReason = useTranslations('finance.fiscal.rejection')
  const attention = fiscalAttentionOf(document)
  if (attention === null) return null
  const core = coreRejectionOf(document.rejectionReason)
  return (
    <div
      role="alert"
      data-testid="fiscal-attention"
      data-attention={attention}
      className="border-destructive/40 bg-destructive/5 flex flex-col gap-1 rounded-md border p-3 text-sm"
    >
      <p className="font-medium">{t(`${attention}.title`)}</p>
      <p className="text-muted-foreground">{t(`${attention}.description`)}</p>
      {document.rejectionReason === null ? null : (
        <p data-testid="fiscal-rejection-reason">
          {core !== null
            ? tReason(core as 'receiver_incomplete')
            : tReason('provider', { code: document.rejectionReason })}
        </p>
      )}
    </div>
  )
}

function Actions({
  document,
  actions,
  onEditReceiver,
  onVoid,
  onConfirmIssuerChange
}: {
  document: FiscalDocumentView
  actions: ReturnType<typeof fiscalActionsOf>
  onEditReceiver: () => void
  onVoid: () => void
  onConfirmIssuerChange: () => void
}): ReactElement | null {
  const t = useTranslations('finance.fiscal.actions')
  const errorText = useFiscalErrorText()
  const { storeId } = useStore()
  const guard = useSubmitGuard()
  const retry = useRetryFiscalDocument(storeId)
  const replace = useReplaceFiscalDocument(storeId)
  const [confirmingReplace, setConfirmingReplace] = useState(false)
  const note = document.kind === FiscalDocumentKind.CREDIT_NOTE
  const [refusal, setRefusal] = useState<string | null>(null)
  const pending = retry.isPending || replace.isPending
  if (
    !actions.editReceiver &&
    !actions.retry &&
    !actions.void &&
    !actions.replace &&
    !actions.replaceFirst &&
    !actions.confirmIssuerChange
  ) {
    return null
  }

  const send = (work: () => Promise<unknown>, done: string): void => {
    if (!guard.enter()) return
    setRefusal(null)
    work()
      .then(() => toast.success(done))
      .catch((error: unknown) => {
        // The api will not move a document that may be at its first issuer: the person confirms that it is not there, which is its own
        // dialog (and the refusal is not left on the screen behind it)
        if (
          error instanceof ApiError &&
          isIssuerChangedInFlight(conflictReasonOf(error.metadata['reason']))
        ) {
          setRefusal(null)
          onConfirmIssuerChange()
          return
        }
        setRefusal(errorText(error))
      })
      .finally(guard.leave)
  }

  return (
    <section className="flex flex-col gap-3 border-t pt-3" aria-label={t('title')}>
      {confirmingReplace ? (
        <div
          className="bg-muted/50 flex flex-col gap-2 rounded-md border p-3 text-sm"
          data-testid="fiscal-replace-confirm"
        >
          <p className="font-medium">
            {t(
              note
                ? 'replaceNoteConfirmTitle'
                : actions.replaceFirst
                  ? 'replaceFirstConfirmTitle'
                  : 'replaceConfirmTitle'
            )}
          </p>
          <p className="text-muted-foreground">
            {t(
              note
                ? 'replaceNoteConfirmDescription'
                : actions.replaceFirst
                  ? 'replaceFirstConfirmDescription'
                  : 'replaceConfirmDescription'
            )}
          </p>
          <div className={`${stickyDialogActionsClass} flex flex-wrap justify-end gap-2`}>
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => setConfirmingReplace(false)}
            >
              {t('cancel')}
            </Button>
            <Button
              size="sm"
              disabled={pending}
              onClick={() =>
                send(
                  async () => {
                    await replace.mutateAsync(document.id)
                    setConfirmingReplace(false)
                  },
                  t(note ? 'replacedNote' : actions.replaceFirst ? 'replacedFirst' : 'replaced')
                )
              }
            >
              {t('replaceConfirm')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {actions.editReceiver ? (
            <Button variant="outline" size="sm" disabled={pending} onClick={onEditReceiver}>
              {t('editReceiver')}
            </Button>
          ) : null}
          {actions.retry ? (
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => send(() => retry.mutateAsync(document.id), t('retried'))}
            >
              {t('retry')}
            </Button>
          ) : null}
          {actions.confirmIssuerChange ? (
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              data-testid="fiscal-issuer-change-open"
              onClick={onConfirmIssuerChange}
            >
              {t('confirmIssuerChange')}
            </Button>
          ) : null}
          {actions.replace ? (
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => setConfirmingReplace(true)}
            >
              {t('replace')}
            </Button>
          ) : null}
          {actions.replaceFirst ? (
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              data-testid="fiscal-replace-first"
              onClick={() => setConfirmingReplace(true)}
            >
              {t('replaceFirst')}
            </Button>
          ) : null}
          {actions.void ? (
            <Button variant="destructive" size="sm" disabled={pending} onClick={onVoid}>
              {t('void')}
            </Button>
          ) : null}
        </div>
      )}
      {refusal === null ? null : (
        <p role="alert" className="text-destructive text-sm">
          {refusal}
        </p>
      )}
    </section>
  )
}

// A visible way out for a touch screen: the dialog has no corner button, and Escape is not there on a phone
function CloseFooter(): ReactElement {
  const tCommon = useTranslations('common')
  return (
    <DialogFooter>
      <DialogClose asChild>
        <Button type="button" variant="outline">
          {tCommon('close')}
        </Button>
      </DialogClose>
    </DialogFooter>
  )
}
