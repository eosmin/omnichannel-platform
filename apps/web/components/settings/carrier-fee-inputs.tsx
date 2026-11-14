'use client'

import { useTranslations } from 'next-intl'
import { type ReactElement, useId } from 'react'

import type { CarrierFeeSettingsView } from '@platform/api-client'

import { carrierRateLabelOf } from '../../lib/settings/carrier-fields'
import { isRateText } from '../../lib/settings/carriers-form'
import { Input } from '../ui/input'
import { Label } from '../ui/label'

// What the owner agrees with a carrier: its commission over the cash it collects (a percent) and what each of its services costs per
// guide. Drawn from what the carrier declares (`feeSettings` of the registry), shared by the connect and the edit dialogs; nothing
// is drawn for a carrier that declares neither. The commission is typed as a percent ("4.5") and the prices in dollars.
export function CarrierFeeInputs({
  fees,
  commission,
  rates,
  onChange,
  disabled,
  commissionInvalid,
  ratesInvalid
}: {
  fees: CarrierFeeSettingsView
  commission: string
  rates: Record<string, string>
  onChange: (change: { commission?: string; rates?: Record<string, string> }) => void
  disabled: boolean
  commissionInvalid: boolean
  ratesInvalid: boolean
}): ReactElement | null {
  const t = useTranslations('settings.carriers.fees')
  const tAll = useTranslations()
  const prefix = useId()
  if (!fees.commission && fees.rateServices.length === 0) return null
  const message = (key: string): string | null =>
    tAll.has(key as Parameters<typeof tAll.has>[0]) ? tAll(key as Parameters<typeof tAll>[0]) : null
  return (
    <fieldset className="flex flex-col gap-3 rounded-lg border p-4">
      <legend className="px-1 text-sm font-medium">{t('legend')}</legend>
      <p className="text-muted-foreground text-xs">{t('hint')}</p>
      {fees.commission ? (
        <div className="grid gap-1.5">
          <Label htmlFor={`${prefix}-commission`}>{t('commission')}</Label>
          <Input
            id={`${prefix}-commission`}
            inputMode="decimal"
            autoComplete="off"
            value={commission}
            onChange={event => onChange({ commission: event.target.value })}
            disabled={disabled}
            className="max-w-32"
            aria-invalid={commissionInvalid}
            aria-describedby={`${prefix}-commission-hint`}
          />
          <p id={`${prefix}-commission-hint`} className="text-muted-foreground text-xs">
            {t('commissionHint')}
          </p>
        </div>
      ) : null}
      {fees.rateServices.length === 0 ? null : (
        <div className="grid gap-2">
          <p className="text-sm font-medium">{t('rates')}</p>
          <p className="text-muted-foreground text-xs">{t('ratesHint')}</p>
          <div className="grid gap-3 sm:grid-cols-3">
            {fees.rateServices.map(service => (
              <div key={service.code} className="grid gap-1.5">
                <Label htmlFor={`${prefix}-rate-${service.code}`}>
                  {carrierRateLabelOf(service, message)}
                </Label>
                <Input
                  id={`${prefix}-rate-${service.code}`}
                  inputMode="decimal"
                  autoComplete="off"
                  value={rates[service.code] ?? ''}
                  onChange={event =>
                    onChange({ rates: { ...rates, [service.code]: event.target.value } })
                  }
                  disabled={disabled}
                  aria-invalid={ratesInvalid && !isRateText(rates[service.code] ?? '')}
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </fieldset>
  )
}
