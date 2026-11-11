'use client'

import { ArrowLeft, ArrowRight } from 'lucide-react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useFormatter, useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import { AppPaths, type TransferView } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'
import { TransferShortageAction, TransferStatus } from '@platform/core/domain'

import { ConfirmRemove } from '../../components/products/confirm-remove'
import { LoadFailed, PageLoading, PermissionDenied } from '../../components/settings/states'
import { TransferCloseDialog } from '../../components/transfers/transfer-close-dialog'
import { TransferDraft } from '../../components/transfers/transfer-draft'
import { TransferReceive } from '../../components/transfers/transfer-receive'
import { TransferStatusBadge } from '../../components/transfers/transfer-status-badge'
import { Button } from '../../components/ui/button'
import { toast } from '../../lib/toast'
import { actionsOf, shortLinesOf } from '../../lib/transfers/transfer-form'
import { type TransferAccess, useTransferAccess } from '../../lib/transfers/use-transfer-access'
import {
  useCancelTransfer,
  useDispatchTransfer,
  useTransfer
} from '../../lib/transfers/use-transfers'
import { useErrorText } from '../../lib/use-error-text'
import { useWarehouses } from '../../lib/warehouses/use-warehouses'

// One transfer (TDD_16 §4.5): the screen is the step it is at. A draft is edited and sent; one on its way is received
// (partly, as many times as needed), closed with a shortage, or cancelled; a received or cancelled one is only read.
export function TransferDetailPage(): ReactElement {
  const access = useTransferAccess()
  if (access === undefined) return <PageLoading />
  return access === null ? (
    <PermissionDenied
      anyOf={[
        ClientPermissions.INVENTORY_MANAGE_TRANSFERS,
        ClientPermissions.INVENTORY_RECEIVE_TRANSFERS
      ]}
    />
  ) : (
    <Detail access={access} />
  )
}

function Detail({ access }: { access: TransferAccess }): ReactElement {
  const t = useTranslations('transfers')
  const { id } = useParams<{ id: string }>()
  const transfer = useTransfer(access.storeId, id)
  return (
    <section className="flex max-w-3xl flex-col gap-4">
      <Link
        href={AppPaths.org.transfers}
        className="text-muted-foreground hover:text-foreground inline-flex w-fit items-center gap-1 text-sm pointer-coarse:min-h-10"
      >
        <ArrowLeft aria-hidden className="size-4" />
        {t('back')}
      </Link>
      {transfer.isError ? (
        <LoadFailed error={transfer.error} onRetry={() => void transfer.refetch()} />
      ) : transfer.data === undefined ? (
        <PageLoading />
      ) : (
        <TransferBody transfer={transfer.data} access={access} />
      )}
    </section>
  )
}

function TransferBody({
  transfer,
  access
}: {
  transfer: TransferView
  access: TransferAccess
}): ReactElement {
  const t = useTranslations('transfers')
  const format = useFormatter()
  const errorText = useErrorText()
  const warehouses = useWarehouses(access.storeId)
  const dispatch = useDispatchTransfer(access.storeId, transfer.id)
  const cancel = useCancelTransfer(access.storeId, transfer.id)
  const [closing, setClosing] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  const may = actionsOf(transfer.status, { manage: access.manage, receive: access.receive })
  const shortUnits = shortLinesOf(transfer.lines).reduce(
    (sum, line) => sum + line.pendingQuantity,
    0
  )
  const when = (value: string): string =>
    format.dateTime(new Date(value), { dateStyle: 'medium', timeStyle: 'short' })

  const send = (): void => {
    setRefusal(null)
    dispatch.mutate(undefined, {
      onSuccess: () => toast.success(t('dispatched')),
      onError: error => setRefusal(errorText(error))
    })
  }

  return (
    <>
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold">{transfer.number}</h1>
          <TransferStatusBadge status={transfer.status} />
        </div>
        <p className="flex flex-wrap items-center gap-1 text-sm">
          <span>{transfer.fromWarehouse.name}</span>
          <ArrowRight aria-hidden className="text-muted-foreground size-4" />
          <span>{transfer.toWarehouse.name}</span>
        </p>
        {transfer.note === null ? null : (
          <p className="text-muted-foreground text-sm">{transfer.note}</p>
        )}
        <p className="text-muted-foreground text-xs">
          {transfer.dispatchedAt === null
            ? t('createdAt', { date: when(transfer.createdAt) })
            : t('dispatchedAt', { date: when(transfer.dispatchedAt) })}
          {transfer.closedAt === null
            ? null
            : ` · ${t('closedAt', { date: when(transfer.closedAt) })}`}
        </p>
      </header>

      {refusal === null ? null : (
        <p role="alert" className="text-destructive text-sm">
          {refusal}
        </p>
      )}

      {may.edit ? (
        warehouses.isError ? (
          <LoadFailed error={warehouses.error} onRetry={() => void warehouses.refetch()} />
        ) : warehouses.data === undefined ? (
          <PageLoading />
        ) : (
          <TransferDraft
            // A save answers with the transfer as it is now: the form starts again from it
            key={transfer.updatedAt}
            transfer={transfer}
            access={access}
            warehouses={warehouses.data}
            onDispatch={send}
            dispatching={dispatch.isPending}
          />
        )
      ) : null}

      {may.receive ? (
        <>
          <TransferReceive
            key={`${transfer.updatedAt}`}
            transfer={transfer}
            storeId={access.storeId}
          />
          {shortUnits > 0 ? (
            <div>
              <Button type="button" variant="outline" onClick={() => setClosing(true)}>
                {t('close.open')}
              </Button>
            </div>
          ) : null}
        </>
      ) : null}

      {may.edit ? null : <ReadOnlyLines transfer={transfer} />}

      {may.cancel ? (
        <div className="border-t pt-4">
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              cancel.reset()
              setCancelling(true)
            }}
          >
            {t('cancel.open')}
          </Button>
        </div>
      ) : null}

      <TransferCloseDialog
        transfer={transfer}
        storeId={access.storeId}
        open={closing}
        onOpenChange={setClosing}
      />
      <ConfirmRemove
        isOpen={cancelling}
        title={t('cancel.title')}
        body={
          transfer.status === TransferStatus.IN_TRANSIT
            ? t('cancel.inTransitBody', {
                warehouse: transfer.fromWarehouse.name,
                count: shortUnits
              })
            : t('cancel.draftBody')
        }
        confirmLabel={t('cancel.confirm')}
        isPending={cancel.isPending}
        error={cancel.error}
        onConfirm={() =>
          cancel.mutate(undefined, {
            onSuccess: () => {
              setCancelling(false)
              toast.success(t('cancel.done'))
            }
          })
        }
        onCancel={() => setCancelling(false)}
      />
    </>
  )
}

// What the lines say once the screen is not editing them: what was sent, what arrived, and what happened to the rest
function ReadOnlyLines({ transfer }: { transfer: TransferView }): ReactElement {
  const t = useTranslations('transfers.lines')
  return (
    <section aria-label={t('label')} className="flex flex-col gap-2">
      <h2 className="text-sm font-medium">{t('heading', { count: transfer.lines.length })}</h2>
      <ul className="divide-y rounded-md border">
        {transfer.lines.map(line => {
          const name =
            line.variantName === null
              ? line.productName
              : `${line.productName} · ${line.variantName}`
          return (
            <li key={line.id} className="flex flex-col gap-0.5 px-4 py-3">
              <span className="text-sm font-medium">{name}</span>
              {line.sku === null ? null : (
                <span className="text-muted-foreground text-xs">{line.sku}</span>
              )}
              <span className="text-sm">
                {t('progress', { sent: line.quantity, received: line.receivedQuantity })}
              </span>
              {line.shortageAction === null ? null : (
                <span className="text-muted-foreground text-xs">
                  {line.shortageAction === TransferShortageAction.WRITE_OFF
                    ? t('writtenOff', { count: line.quantity - line.receivedQuantity })
                    : t('returned', { count: line.quantity - line.receivedQuantity })}
                </span>
              )}
            </li>
          )
        })}
      </ul>
      <p className="text-muted-foreground text-xs">{t('ownStoresOnly')}</p>
    </section>
  )
}
