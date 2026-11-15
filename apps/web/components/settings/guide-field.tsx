'use client'

import type { ReactElement } from 'react'

import { Input } from '../ui/input'
import { Label } from '../ui/label'

// One labeled text field of the guide balance forms, with an optional hint under it
export function GuideField({
  id,
  label,
  hint,
  value,
  onChange,
  invalid,
  disabled,
  inputMode,
  max,
  type
}: {
  id: string
  label: string
  hint?: string
  value: string
  onChange: (value: string) => void
  invalid: boolean
  disabled: boolean
  inputMode?: 'numeric' | 'decimal' | 'text'
  max?: number
  type?: 'text' | 'date'
}): ReactElement {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={type ?? 'text'}
        value={value}
        onChange={event => onChange(event.target.value)}
        inputMode={inputMode}
        maxLength={max}
        autoComplete="off"
        disabled={disabled}
        aria-invalid={invalid}
        aria-describedby={hint === undefined ? undefined : `${id}-hint`}
      />
      {hint === undefined ? null : (
        <p id={`${id}-hint`} className="text-muted-foreground text-xs">
          {hint}
        </p>
      )}
    </div>
  )
}
