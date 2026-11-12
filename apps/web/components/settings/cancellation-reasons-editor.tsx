'use client'

import { ArrowDown, ArrowUp, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type ReactElement, useId, useState } from 'react'

import { OrderCancellationReasons } from '@platform/core/domain'
import { type CancellationReason, CancellationReasonLimits } from '@platform/core/store-preferences'

import {
  addCustomReason,
  factoryReasons,
  moveReason,
  removeReason,
  renameReason
} from '../../lib/settings/preferences-form'
import { Button } from '../ui/button'
import { Input } from '../ui/input'

// The dropdown of the cancel dialog (TDD_09 §5.3, TDD_17 §4.14), as the store keeps it: the factory reasons are translated
// by their key and cannot be renamed; the reasons the store typed are its own words. Anyone may be removed and the order of
// the list is the order of the dialog. Nothing here is saved: the form that holds it sends the list.
const FACTORY_KEYS: readonly string[] = Object.values(OrderCancellationReasons)

export function CancellationReasonsEditor({
  reasons,
  onChange,
  disabled
}: {
  reasons: CancellationReason[]
  onChange: (next: CancellationReason[]) => void
  disabled: boolean
}): ReactElement {
  const t = useTranslations('settings.preferences.reasons')
  const tAll = useTranslations()
  const idPrefix = useId()
  const [newLabel, setNewLabel] = useState('')
  const full = reasons.length >= CancellationReasonLimits.MAX_ENTRIES
  const add = (): void => {
    if (newLabel.trim() === '' || full) return
    onChange(addCustomReason(reasons, newLabel))
    setNewLabel('')
  }
  // A key this version does not ship is shown by the text the reason carries, or its id, never as a raw key
  const textOf = (reason: CancellationReason): string =>
    reason.labelKey === undefined
      ? (reason.label ?? '')
      : FACTORY_KEYS.includes(reason.labelKey)
        ? tAll(reason.labelKey as 'orders.cancellationReason.other')
        : (reason.label ?? reason.id)

  return (
    <div className="flex flex-col gap-3">
      <ul aria-label={t('listLabel')} className="flex flex-col gap-2">
        {reasons.map((reason, index) => (
          <li key={reason.id} className="flex items-center gap-2">
            {reason.label === undefined ? (
              <span className="flex-1 text-sm">{textOf(reason)}</span>
            ) : (
              <Input
                value={reason.label}
                maxLength={CancellationReasonLimits.MAX_LABEL_LENGTH * 2}
                aria-label={t('textLabel', { position: index + 1 })}
                disabled={disabled}
                onChange={event => onChange(renameReason(reasons, reason.id, event.target.value))}
                className="flex-1"
              />
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t('moveUp', { reason: textOf(reason) })}
              disabled={disabled || index === 0}
              onClick={() => onChange(moveReason(reasons, reason.id, -1))}
            >
              <ArrowUp aria-hidden className="size-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t('moveDown', { reason: textOf(reason) })}
              disabled={disabled || index === reasons.length - 1}
              onClick={() => onChange(moveReason(reasons, reason.id, 1))}
            >
              <ArrowDown aria-hidden className="size-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t('remove', { reason: textOf(reason) })}
              disabled={disabled}
              onClick={() => onChange(removeReason(reasons, reason.id))}
            >
              <Trash2 aria-hidden className="size-4" />
            </Button>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={`${idPrefix}-new`}
          value={newLabel}
          placeholder={t('newPlaceholder')}
          aria-label={t('newLabel')}
          disabled={disabled || full}
          onChange={event => setNewLabel(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault()
              add()
            }
          }}
          className="max-w-xs"
        />
        <Button
          type="button"
          variant="outline"
          disabled={disabled || full || newLabel.trim() === ''}
          onClick={add}
        >
          <Plus aria-hidden className="size-4" />
          {t('add')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={disabled}
          onClick={() => onChange(factoryReasons())}
        >
          <RotateCcw aria-hidden className="size-4" />
          {t('restore')}
        </Button>
      </div>
      {full ? <p className="text-muted-foreground text-xs">{t('full')}</p> : null}
    </div>
  )
}
