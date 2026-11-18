'use client'

import { useTranslations } from 'next-intl'
import { type ReactElement, useId } from 'react'

import { ClientPermissions } from '@platform/core/auth'
import { CarrierChargeModel } from '@platform/core/domain'

import { useStore } from '../providers/store-context'
import { Label } from '../ui/label'

// How the carrier charges the business for its guides: it decides what the books owe the carrier (TDD_18 §4.2, note on E4). It is agreed
// with the fees, so it is shown, and changed, only to who may view the carrier fees (the server refuses the change to anyone else).
export function CarrierChargeModelField({
  value,
  onChange,
  disabled
}: {
  value: string
  onChange: (value: string) => void
  disabled: boolean
}): ReactElement | null {
  const t = useTranslations('settings.carriers.rules.chargeModel')
  const id = useId()
  const { can } = useStore()
  if (!can(ClientPermissions.FINANCE_VIEW_CARRIER_FEES)) return null
  // An unknown model (a newer server) reads as the default one
  const hint = (model: string): string =>
    model === String(CarrierChargeModel.PREPAID)
      ? t('hints.prepaid')
      : model === String(CarrierChargeModel.REMITTANCE)
        ? t('hints.remittance')
        : t('hints.invoiced')
  return (
    <fieldset className="flex flex-col gap-3 rounded-lg border p-4">
      <legend className="px-1 text-sm font-medium">{t('legend')}</legend>
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-model`}>{t('label')}</Label>
        <select
          id={`${id}-model`}
          value={value}
          onChange={event => onChange(event.target.value)}
          disabled={disabled}
          className="border-input bg-background h-9 max-w-xs rounded-md border px-2 text-sm"
          aria-describedby={`${id}-hint`}
        >
          <option value={CarrierChargeModel.INVOICED}>{t('models.invoiced')}</option>
          <option value={CarrierChargeModel.REMITTANCE}>{t('models.remittance')}</option>
          <option value={CarrierChargeModel.PREPAID}>{t('models.prepaid')}</option>
        </select>
        <p id={`${id}-hint`} className="text-muted-foreground text-xs">
          {hint(value)}
        </p>
      </div>
    </fieldset>
  )
}
