'use client'

import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { useCarrierLocations } from '../../lib/orders/use-order-guides'
import { SELECT_CLASS } from '../ui/field-classes'
import { Label } from '../ui/label'

// The department and municipality of the address, in the carrier's own ids (`GET /carriers/:id/locations`, two levels: the top list
// and the list under the department chosen). What the carrier lists is drawn as it comes; nothing here names a carrier. Changing the
// department clears the municipality, which belongs to it.
export function GuideLocationSelects({
  id,
  storeId,
  connectionId,
  departmentId,
  municipalityId,
  onChange
}: {
  id: string
  storeId: string
  connectionId: string
  departmentId: string
  municipalityId: string
  onChange: (next: { departmentId: string; municipalityId: string }) => void
}): ReactElement {
  const t = useTranslations('orders.detail.guide.locations')
  const departments = useCarrierLocations(storeId, connectionId, null, true)
  const municipalities = useCarrierLocations(
    storeId,
    connectionId,
    departmentId === '' ? null : departmentId,
    departmentId !== ''
  )
  const failed = departments.isError || municipalities.isError
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-sm font-medium">{t('legend')}</legend>
      <p className="text-muted-foreground text-xs">{t('hint')}</p>
      <div className="flex flex-wrap gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-department`}>{t('department')}</Label>
          <select
            id={`${id}-department`}
            className={SELECT_CLASS}
            value={departmentId}
            disabled={departments.isPending}
            aria-invalid={departments.isError}
            onChange={event => onChange({ departmentId: event.target.value, municipalityId: '' })}
          >
            <option value="">{departments.isPending ? t('loading') : t('choose')}</option>
            {(departments.data ?? []).map(place => (
              <option key={place.id} value={place.id}>
                {place.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-municipality`}>{t('municipality')}</Label>
          <select
            id={`${id}-municipality`}
            className={SELECT_CLASS}
            value={municipalityId}
            disabled={departmentId === '' || municipalities.isPending}
            aria-invalid={municipalities.isError}
            onChange={event => onChange({ departmentId, municipalityId: event.target.value })}
          >
            <option value="">
              {departmentId !== '' && municipalities.isPending ? t('loading') : t('choose')}
            </option>
            {(municipalities.data ?? []).map(place => (
              <option key={place.id} value={place.id}>
                {place.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      {failed ? (
        <p role="alert" className="text-destructive text-xs">
          {t('failed')}
        </p>
      ) : null}
    </fieldset>
  )
}
