'use client'

import { useLocale, useTranslations } from 'next-intl'
import { type ReactElement, useId } from 'react'

import type { CarrierConnectFieldView } from '@platform/api-client'

import { carrierFieldHelpOf, carrierFieldLabelOf } from '../../lib/settings/carrier-fields'
import type { ConnectValues } from '../../lib/settings/connect-form'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Textarea } from '../ui/textarea'

// The inputs of the fields a carrier declares, shared by the connect dialog and the edit dialog. A secret is typed in a
// masked field and is never shown again; a field that holds a list takes one entry per line. The text of a field that may be
// left empty says so itself (the plugin writes it), so nothing is added here.
export function CarrierFieldInputs({
  fields,
  values,
  onChange,
  disabled,
  invalid
}: {
  fields: readonly CarrierConnectFieldView[]
  values: ConnectValues
  onChange: (values: ConnectValues) => void
  disabled: boolean
  invalid: (field: CarrierConnectFieldView) => boolean
}): ReactElement {
  const t = useTranslations('settings.carriers.connect')
  const tAll = useTranslations()
  const locale = useLocale()
  const prefix = useId()
  const message = (key: string): string | null =>
    tAll.has(key as Parameters<typeof tAll.has>[0]) ? tAll(key as Parameters<typeof tAll>[0]) : null
  return (
    <>
      {fields.map(field => {
        const id = `${prefix}-${field.key}`
        const help = carrierFieldHelpOf(field, message)
        const helpId = help === null ? undefined : `${id}-help`
        const label = carrierFieldLabelOf(field, locale, message)
        const set = (value: string): void => onChange({ ...values, [field.key]: value })
        return (
          <div key={field.key} className="grid gap-1.5">
            <Label htmlFor={id}>{label}</Label>
            {field.multiple && !field.secret ? (
              <Textarea
                id={id}
                rows={3}
                autoComplete="off"
                spellCheck={false}
                value={values[field.key] ?? ''}
                onChange={event => set(event.target.value)}
                disabled={disabled}
                aria-invalid={invalid(field)}
                aria-describedby={helpId}
              />
            ) : (
              <Input
                id={id}
                // A secret is masked, and the browser is told not to keep it (`off` is ignored for a password field)
                type={field.secret ? 'password' : 'text'}
                autoComplete={field.secret ? 'new-password' : 'off'}
                spellCheck={false}
                value={values[field.key] ?? ''}
                onChange={event => set(event.target.value)}
                disabled={disabled}
                aria-invalid={invalid(field)}
                aria-describedby={helpId}
              />
            )}
            {help === null ? null : (
              <p id={helpId} className="text-muted-foreground text-xs">
                {help}
              </p>
            )}
            {field.secret ? (
              <p className="text-muted-foreground text-xs">{t('secretHint')}</p>
            ) : null}
          </div>
        )
      })}
    </>
  )
}
