'use client'

import { Trash2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useId, useState } from 'react'

import type { TransferView, WarehouseDetailView } from '@platform/api-client'
import { TransferLimits } from '@platform/core/domain'

import { useSubmitGuard } from '../../lib/submit-guard'
import { toast } from '../../lib/toast'
import {
  addToDraft,
  type DraftLine,
  draftChanged,
  draftInputOf,
  draftLinesOf
} from '../../lib/transfers/transfer-form'
import type { TransferAccess } from '../../lib/transfers/use-transfer-access'
import { useUpdateTransfer } from '../../lib/transfers/use-transfers'
import { useErrorText } from '../../lib/use-error-text'
import { Button } from '../ui/button'
import { SELECT_CLASS } from '../ui/field-classes'
import { Input } from '../ui/input'
import { Label } from '../ui/label'

import { ItemPicker } from './item-picker'

// The draft of a transfer: where it leaves from and goes to, a note, and the items. Everything is saved whole (the
// api replaces the lines of the stores of the person), so what is on screen is what gets sent. A draft that has
// unsaved changes cannot be sent: the person saves first and sends what they saw.
export function TransferDraft({
  transfer,
  access,
  warehouses,
  onDispatch,
  dispatching
}: {
  transfer: TransferView
  access: TransferAccess
  warehouses: readonly WarehouseDetailView[]
  onDispatch: () => void
  dispatching: boolean
}): ReactElement {
  const t = useTranslations('transfers.draft')
  const errorText = useErrorText()
  const ids = useId()
  const guard = useSubmitGuard()
  const update = useUpdateTransfer(access.storeId, transfer.id)
  const [from, setFrom] = useState(transfer.fromWarehouse.id)
  const [to, setTo] = useState(transfer.toWarehouse.id)
  const [note, setNote] = useState(transfer.note ?? '')
  const [lines, setLines] = useState<DraftLine[]>(() => draftLinesOf(transfer))
  const [wrongKey, setWrongKey] = useState<string | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)

  const trimmedNote = note.trim()
  const headerChanged =
    from !== transfer.fromWarehouse.id ||
    to !== transfer.toWarehouse.id ||
    trimmedNote !== (transfer.note ?? '')
  const changed = headerChanged || draftChanged(lines, transfer)
  const sameWarehouse = from === to

  const edit = (apply: () => void): void => {
    apply()
    setWrongKey(null)
    setRefusal(null)
  }

  const save = (event: FormEvent): void => {
    event.preventDefault()
    if (!changed || sameWarehouse) return
    const input = draftInputOf(lines)
    if (!input.ok) {
      setWrongKey(input.wrongKey)
      return
    }
    if (!guard.enter()) return
    update.mutate(
      {
        ...(from === transfer.fromWarehouse.id ? {} : { fromWarehouseId: from }),
        ...(to === transfer.toWarehouse.id ? {} : { toWarehouseId: to }),
        ...(trimmedNote === (transfer.note ?? '')
          ? {}
          : { note: trimmedNote === '' ? null : trimmedNote }),
        lines: input.lines
      },
      {
        // The detail page mounts this form again with what the api answered (keyed by `updatedAt`)
        onSuccess: () => toast.success(t('saved')),
        onError: error => setRefusal(errorText(error)),
        onSettled: guard.leave
      }
    )
  }

  const choices = warehouses.filter(
    warehouse => warehouse.active || warehouse.id === from || warehouse.id === to
  )
  const warehouseSelect = (
    id: string,
    label: string,
    value: string,
    set: (next: string) => void
  ): ReactElement => (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        className={SELECT_CLASS}
        value={value}
        onChange={event => edit(() => set(event.target.value))}
      >
        {choices.map(warehouse => (
          <option key={warehouse.id} value={warehouse.id}>
            {warehouse.code} · {warehouse.name}
          </option>
        ))}
      </select>
    </div>
  )

  return (
    <form onSubmit={save} noValidate className="flex flex-col gap-4" aria-label={t('formLabel')}>
      <div className="grid gap-3 sm:grid-cols-2">
        {warehouseSelect(`${ids}-from`, t('from'), from, setFrom)}
        {warehouseSelect(`${ids}-to`, t('to'), to, setTo)}
      </div>
      {sameWarehouse ? (
        <p role="alert" className="text-destructive text-sm">
          {t('sameWarehouse')}
        </p>
      ) : null}
      <div className="grid gap-1.5">
        <Label htmlFor={`${ids}-note`}>{t('note')}</Label>
        <Input
          id={`${ids}-note`}
          value={note}
          maxLength={TransferLimits.NOTE_MAX_LENGTH}
          onChange={event => edit(() => setNote(event.target.value))}
        />
      </div>

      <ItemPicker
        stores={access.makingStores}
        onAdd={line => edit(() => setLines(current => addToDraft(current, line)))}
      />

      <section className="flex flex-col gap-2" aria-label={t('linesLabel')}>
        <h2 className="text-sm font-medium">{t('lines', { count: lines.length })}</h2>
        {lines.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('noLines')}</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {lines.map(line => (
              <DraftLineRow
                key={line.key}
                line={line}
                wrong={wrongKey === line.key}
                onChange={quantity =>
                  edit(() =>
                    setLines(current =>
                      current.map(item => (item.key === line.key ? { ...item, quantity } : item))
                    )
                  )
                }
                onRemove={() =>
                  edit(() => setLines(current => current.filter(item => item.key !== line.key)))
                }
              />
            ))}
          </ul>
        )}
        <p className="text-muted-foreground text-xs">{t('ownStoresOnly')}</p>
      </section>

      {refusal === null ? null : (
        <p role="alert" className="text-destructive text-sm">
          {refusal}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" busy={update.isPending} disabled={!changed || sameWarehouse}>
          {t('save')}
        </Button>
        <Button
          type="button"
          variant="outline"
          busy={dispatching}
          disabled={changed || lines.length === 0 || update.isPending}
          onClick={onDispatch}
        >
          {t('dispatch')}
        </Button>
        {changed ? <span className="text-muted-foreground text-xs">{t('saveFirst')}</span> : null}
      </div>
    </form>
  )
}

function DraftLineRow({
  line,
  wrong,
  onChange,
  onRemove
}: {
  line: DraftLine
  wrong: boolean
  onChange: (quantity: string) => void
  onRemove: () => void
}): ReactElement {
  const t = useTranslations('transfers.draft')
  const id = useId()
  const name =
    line.variantName === null ? line.productName : `${line.productName} · ${line.variantName}`
  return (
    <li className="flex items-center gap-3 px-3 py-2">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium">{name}</span>
        {line.sku === null ? null : (
          <span className="text-muted-foreground text-xs">{line.sku}</span>
        )}
        {wrong ? (
          <span id={`${id}-error`} role="alert" className="text-destructive text-xs">
            {t('wrongUnits')}
          </span>
        ) : null}
      </div>
      <Label htmlFor={id} className="sr-only">
        {t('unitsOf', { name })}
      </Label>
      <Input
        id={id}
        inputMode="numeric"
        className="w-24 text-right"
        value={line.quantity}
        aria-invalid={wrong}
        aria-describedby={wrong ? `${id}-error` : undefined}
        onChange={event => onChange(event.target.value)}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={t('remove', { name })}
        onClick={onRemove}
      >
        <Trash2 aria-hidden />
      </Button>
    </li>
  )
}
