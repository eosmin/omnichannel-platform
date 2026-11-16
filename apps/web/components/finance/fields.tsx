'use client'

import { type ReactElement, type ReactNode, useId } from 'react'

import { SELECT_CLASS } from '../ui/field-classes'
import { Input } from '../ui/input'
import { Label } from '../ui/label'

// The two fields of the finance forms: a label, the control, a hint and the problem, joined for a screen reader
export function TextField({
  label,
  value,
  onChange,
  problem = null,
  hint,
  maxLength,
  disabled = false,
  inputMode,
  autoCapitalize,
  type = 'text'
}: {
  label: string
  value: string
  onChange: (value: string) => void
  problem?: string | null
  hint?: string
  maxLength?: number
  disabled?: boolean
  inputMode?: 'numeric' | 'decimal' | 'text'
  autoCapitalize?: string
  // A day is picked with the browser's own control on a phone; the value is always 'YYYY-MM-DD'
  type?: 'text' | 'date'
}): ReactElement {
  const id = useId()
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={type}
        value={value}
        maxLength={maxLength}
        disabled={disabled}
        inputMode={inputMode}
        autoCapitalize={autoCapitalize}
        aria-invalid={problem !== null}
        aria-describedby={problem === null ? undefined : `${id}-error`}
        onChange={event => onChange(event.target.value)}
      />
      <FieldNote id={id} hint={hint} problem={problem} />
    </div>
  )
}

export function SelectField({
  label,
  value,
  onChange,
  children,
  problem = null,
  hint,
  disabled = false
}: {
  label: string
  value: string
  onChange: (value: string) => void
  children: ReactNode
  problem?: string | null
  hint?: string
  disabled?: boolean
}): ReactElement {
  const id = useId()
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        className={SELECT_CLASS}
        value={value}
        disabled={disabled}
        aria-invalid={problem !== null}
        aria-describedby={problem === null ? undefined : `${id}-error`}
        onChange={event => onChange(event.target.value)}
      >
        {children}
      </select>
      <FieldNote id={id} hint={hint} problem={problem} />
    </div>
  )
}

function FieldNote({
  id,
  hint,
  problem
}: {
  id: string
  hint?: string
  problem: string | null
}): ReactElement {
  return (
    <>
      {hint === undefined ? null : <p className="text-muted-foreground text-xs">{hint}</p>}
      {problem === null ? null : (
        <p id={`${id}-error`} role="alert" className="text-destructive text-sm">
          {problem}
        </p>
      )}
    </>
  )
}
