'use client'

import { Plus, Trash2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type ReactElement, useId } from 'react'

import { FiscalFieldLimits } from '@platform/core/domain'

import { type AddressRow, emptyAddressRow } from '../../lib/fiscal/address-rows'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'

// The address of a fiscal document as rows: the name of the line as the provider asks for it, and its value
export function AddressRowsField({
  rows,
  onChange,
  problem,
  disabled,
  hint,
  required = false
}: {
  rows: readonly AddressRow[]
  onChange: (rows: AddressRow[]) => void
  // Already in words
  problem: string | null
  disabled: boolean
  hint?: string
  // The provider asks for an address (its manifest says so)
  required?: boolean
}): ReactElement {
  const t = useTranslations('finance.fiscal.address')
  const id = useId()
  const set = (index: number, patch: Partial<AddressRow>): void =>
    onChange(rows.map((row, at) => (at === index ? { ...row, ...patch } : row)))
  return (
    <fieldset
      className="grid gap-2"
      aria-describedby={problem === null ? undefined : `${id}-error`}
    >
      <legend className="text-sm font-medium">
        {required ? `${t('legend')} ${t('requiredMark')}` : t('legend')}
      </legend>
      {hint === undefined ? null : <p className="text-muted-foreground text-xs">{hint}</p>}
      {rows.map((row, index) => (
        <div
          key={row.id}
          role="group"
          aria-label={t('rowLabel', { number: index + 1 })}
          data-testid="fiscal-address-row"
          className="grid grid-cols-[1fr_1fr_auto] items-end gap-2"
        >
          <div className="grid gap-1">
            <Label htmlFor={`${id}-key-${String(index)}`} className="text-xs">
              {t('key')}
            </Label>
            <Input
              id={`${id}-key-${String(index)}`}
              value={row.key}
              maxLength={FiscalFieldLimits.ADDRESS_KEY}
              disabled={disabled}
              onChange={event => set(index, { key: event.target.value })}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor={`${id}-value-${String(index)}`} className="text-xs">
              {t('value')}
            </Label>
            <Input
              id={`${id}-value-${String(index)}`}
              value={row.value}
              maxLength={FiscalFieldLimits.ADDRESS_VALUE}
              disabled={disabled}
              onChange={event => set(index, { value: event.target.value })}
            />
          </div>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={t('remove', { number: index + 1 })}
            disabled={disabled || rows.length === 1}
            onClick={() => onChange(rows.filter((_, at) => at !== index))}
          >
            <Trash2 aria-hidden />
          </Button>
        </div>
      ))}
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || rows.length >= FiscalFieldLimits.ADDRESS_MAX_FIELDS}
          onClick={() => onChange([...rows, emptyAddressRow()])}
        >
          <Plus aria-hidden />
          {t('add')}
        </Button>
      </div>
      {problem === null ? null : (
        <p id={`${id}-error`} role="alert" className="text-destructive text-sm">
          {problem}
        </p>
      )}
    </fieldset>
  )
}
